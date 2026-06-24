import { eq } from 'drizzle-orm';
import { DEFAULT_REMOTE_SHELL } from '@main/core/execution-context/remote-shell-profile';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { k8sConfigFromRow } from '@main/core/k8s/config/connection-metadata';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { KubeConnectionManagerEvent } from '@main/core/k8s/lifecycle/kube-connection-manager';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { previewServerService } from '@main/core/preview-servers/preview-server-service-instance';
import { wireTerminalUrlDetector } from '@main/core/preview-servers/terminal-url-detector';
import { isUnexpectedPtyExit } from '@main/core/pty/exit-classification';
import { openK8sPty } from '@main/core/pty/k8s-pty';
import type { Pty } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { resolveK8sCommand } from '@main/core/pty/spawn-utils';
import { killTmuxSession, makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { resolveTerminalShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import {
  type LifecycleScriptSpawnRequest,
  type TerminalProvider,
  type TerminalSpawnOptions,
} from '@main/core/terminals/terminal-provider';
import { db } from '@main/db/client';
import { k8sConnections as k8sConnectionsTable } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { GeneralSessionConfig } from '@shared/core/terminals/general-session';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import type { Terminal } from '@shared/core/terminals/terminals';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_RESPAWNS = 2;

/**
 * The shell a session should run. Either a standard terminal shell id (where
 * 'system' uses the pod's `$SHELL`), or the connection-default `'sh'`, which is
 * resolved deterministically to `/bin/sh` regardless of the pod's `$SHELL`.
 */
type K8sShellIntent = TerminalShellId | 'sh';

type SpawnPolicy = {
  respawnOnExit: boolean;
  preserveBufferOnExit: boolean;
  watchDevServer: boolean;
  trackForRehydrate: boolean;
};

export class K8sTerminalProvider implements TerminalProvider {
  readonly kind = 'k8s' as const;
  private sessions = new Map<string, Pty>();
  private knownSessionIds = new Set<string>();
  private shellProfiles = new Map<string, ResolvedShellProfile>();
  /** Session ids spawned under tmux, so cleanup matches what each session used. */
  private tmuxSessions = new Set<string>();
  private respawnCounts = new Map<string, number>();
  private terminals = new Map<string, Terminal>();
  private readonly projectId: string;
  private readonly workspaceId: string;
  private readonly scopeId: string;
  private readonly taskPath: string;
  private readonly taskEnvVars: Record<string, string>;
  private readonly tmux: boolean;
  private readonly defaultShell: 'sh' | 'bash' | 'zsh';
  private readonly shellSetup?: string;
  private readonly ctx: IExecutionContext;
  private readonly proxy: KubeClientProxy;
  private readonly connectionId: string;
  private readonly _handleReconnect: (evt: KubeConnectionManagerEvent) => void;

  constructor({
    projectId,
    workspaceId,
    scopeId,
    taskPath,
    taskEnvVars = {},
    tmux = false,
    defaultShell = 'sh',
    shellSetup,
    ctx,
    proxy,
    connectionId,
  }: {
    projectId: string;
    workspaceId: string;
    scopeId: string;
    taskPath: string;
    taskEnvVars?: Record<string, string>;
    tmux?: boolean;
    defaultShell?: 'sh' | 'bash' | 'zsh';
    shellSetup?: string;
    ctx: IExecutionContext;
    proxy: KubeClientProxy;
    connectionId: string;
  }) {
    this.projectId = projectId;
    this.workspaceId = workspaceId;
    this.scopeId = scopeId;
    this.taskPath = taskPath;
    this.taskEnvVars = taskEnvVars;
    this.tmux = tmux;
    this.defaultShell = defaultShell;
    this.shellSetup = shellSetup;
    this.ctx = ctx;
    this.proxy = proxy;
    this.connectionId = connectionId;
    this._handleReconnect = (evt: KubeConnectionManagerEvent) => {
      if (evt.type === 'reconnected' && evt.connectionId === this.connectionId) {
        this.rehydrate().catch((e: unknown) => {
          log.error('K8sTerminalProvider: rehydrate failed after reconnect', {
            scopeId: this.scopeId,
            connectionId: this.connectionId,
            error: String(e),
          });
        });
      }
    };
    kubeConnectionManager.on('connection-event', this._handleReconnect);
  }

  /**
   * The connection's default shell is read live (not snapshotted at construction)
   * so editing it on the connection applies to newly spawned terminals without
   * re-provisioning the workspace. Falls back to the construction-time value.
   */
  private async currentDefaultShell(): Promise<'sh' | 'bash' | 'zsh'> {
    try {
      const [row] = await db
        .select()
        .from(k8sConnectionsTable)
        .where(eq(k8sConnectionsTable.id, this.connectionId))
        .limit(1);
      return row ? (k8sConfigFromRow(row).shell ?? this.defaultShell) : this.defaultShell;
    } catch {
      return this.defaultShell;
    }
  }

  /**
   * Whether new sessions run under tmux is read live (not snapshotted at
   * construction) so toggling tmux on the connection applies to newly spawned
   * terminals without re-provisioning the workspace. Falls back to the
   * construction-time value (which already encodes any project-level override).
   */
  private async currentTmuxEnabled(): Promise<boolean> {
    try {
      const [row] = await db
        .select()
        .from(k8sConnectionsTable)
        .where(eq(k8sConnectionsTable.id, this.connectionId))
        .limit(1);
      return row ? (k8sConfigFromRow(row).tmux ?? this.tmux) : this.tmux;
    } catch {
      return this.tmux;
    }
  }

  async spawnTerminal(
    terminal: Terminal,
    initialSize: { cols: number; rows: number } = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    options: TerminalSpawnOptions = {}
  ): Promise<void> {
    // 'system' (from either the spawn options or the persisted shellId) means
    // "use this connection's default shell" for k8s — `createTerminal` passes
    // options.shell:'system' for newly added terminals, so we must map both
    // sources, not just the persisted id. An explicit non-'system' shell wins.
    const requested = options.shell ?? terminal.shellId;
    const shellIntent: K8sShellIntent =
      requested === 'system' ? await this.currentDefaultShell() : requested;
    return this.spawnWithPolicy(terminal, initialSize, options.command, undefined, shellIntent, {
      respawnOnExit: true,
      preserveBufferOnExit: false,
      watchDevServer: true,
      trackForRehydrate: true,
    });
  }

  async spawnLifecycleScript({
    terminal,
    command,
    shellSetup,
    initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    respawnOnExit = false,
    preserveBufferOnExit = true,
    watchDevServer = false,
  }: LifecycleScriptSpawnRequest): Promise<void> {
    return this.spawnWithPolicy(
      terminal,
      initialSize,
      command === undefined ? undefined : { command, args: [] },
      shellSetup,
      'system',
      {
        respawnOnExit,
        preserveBufferOnExit,
        watchDevServer,
        trackForRehydrate: false,
      }
    );
  }

  private async spawnWithPolicy(
    terminal: Terminal,
    initialSize: { cols: number; rows: number },
    command: { command: string; args: string[] } | undefined,
    shellSetup: string | undefined,
    shellIntent: K8sShellIntent,
    policy: SpawnPolicy
  ): Promise<void> {
    const sessionId = makePtySessionId(terminal.projectId, terminal.taskId, terminal.id);
    this.knownSessionIds.add(sessionId);
    if (this.sessions.has(sessionId)) return;
    if (policy.trackForRehydrate) {
      this.terminals.set(terminal.id, terminal);
    }

    const useTmux = await this.currentTmuxEnabled();
    if (useTmux) this.tmuxSessions.add(sessionId);
    else this.tmuxSessions.delete(sessionId);

    const cfg: GeneralSessionConfig = {
      taskId: this.scopeId,
      cwd: this.taskPath,
      shellSetup: shellSetup ?? this.shellSetup,
      tmuxSessionName: useTmux ? makeTmuxSessionName(sessionId) : undefined,
      command: command?.command,
      args: command?.args,
    };

    const shellProfile = await this.getSessionShellProfile(sessionId, shellIntent);
    const k8sCommand = resolveK8sCommand('general', cfg, this.taskEnvVars, shellProfile);

    const result = await openK8sPty(this.proxy, {
      id: sessionId,
      command: k8sCommand,
      cols: initialSize.cols,
      rows: initialSize.rows,
    });

    if (!result.success) {
      log.error('K8sTerminalProvider: failed to open exec session', {
        sessionId,
        error: result.error.message,
      });
      throw new Error(result.error.message);
    }
    const pty = result.data;

    if (policy.watchDevServer) {
      wireTerminalUrlDetector({
        pty,
        probeLocalPorts: false,
        onDetected: (server) => {
          void previewServerService
            .registerDetectedTarget({
              projectId: this.projectId,
              workspaceId: this.workspaceId,
              connectionId: this.connectionId,
              transport: 'k8s',
              proxy: this.proxy,
              source: { kind: 'terminal-output', terminalId: terminal.id },
              protocol: server.protocol,
              port: server.port,
              urlPath: server.urlPath,
            })
            .catch((error) => {
              log.warn('K8sTerminalProvider: preview target registration failed', {
                terminalId: terminal.id,
                connectionId: this.connectionId,
                error: String(error),
              });
            });
        },
        onSourceClosed: (event) =>
          previewServerService.handleTerminalSourceClosed({
            projectId: this.projectId,
            workspaceId: this.workspaceId,
            terminalId: terminal.id,
            transport: 'k8s',
            connectionId: this.connectionId,
            reason: event.reason,
            server: 'server' in event ? event.server : undefined,
          }),
      });
    }

    pty.onExit((info) => {
      const { exitCode, signal } = info;
      const shouldRespawn =
        policy.respawnOnExit &&
        this.sessions.has(sessionId) &&
        isUnexpectedPtyExit({ exitCode, signal });
      this.sessions.delete(sessionId);
      if (!policy.preserveBufferOnExit) {
        ptySessionRegistry.unregister(sessionId, { pty, exitInfo: info });
      }
      if (shouldRespawn && !useTmux) {
        const count = (this.respawnCounts.get(sessionId) ?? 0) + 1;
        this.respawnCounts.set(sessionId, count);

        if (count > MAX_RESPAWNS) {
          log.error('K8sTerminalProvider: respawn limit reached, giving up', {
            terminalId: terminal.id,
            respawnCount: count,
          });
          this.respawnCounts.delete(sessionId);
          this.shellProfiles.delete(sessionId);
          return;
        }

        setTimeout(() => {
          this.spawnWithPolicy(
            terminal,
            initialSize,
            command,
            shellSetup,
            shellIntent,
            policy
          ).catch((e) => {
            log.error('K8sTerminalProvider: respawn failed', {
              terminalId: terminal.id,
              error: String(e),
            });
          });
        }, 500);
      } else {
        this.shellProfiles.delete(sessionId);
      }
    });

    ptySessionRegistry.register(sessionId, pty, {
      preserveBufferOnExit: policy.preserveBufferOnExit,
    });
    this.sessions.set(sessionId, pty);
  }

  private async getSessionShellProfile(
    sessionId: string,
    shellIntent: K8sShellIntent
  ): Promise<ResolvedShellProfile> {
    const existing = this.shellProfiles.get(sessionId);
    if (existing) return existing;
    const remoteProfile = await this.proxy.getRemoteShellProfile();

    // 'sh' resolves deterministically to /bin/sh: use the 'system' resolver path
    // but force the profile shell to /bin/sh so the pod's $SHELL is ignored.
    const resolvedIntent: TerminalShellId = shellIntent === 'sh' ? 'system' : shellIntent;
    const profile = await resolveTerminalShellWithSystemFallback({
      intent: resolvedIntent,
      target: {
        kind: 'k8s',
        proxy: this.proxy,
        profile:
          shellIntent === 'sh' ? { ...remoteProfile, shell: DEFAULT_REMOTE_SHELL } : remoteProfile,
      },
      onFallback: () => {
        log.warn('K8sTerminalProvider: stored shell unavailable, using system shell', {
          shell: shellIntent,
          sessionId,
        });
      },
    });
    this.shellProfiles.set(sessionId, profile);
    return profile;
  }

  /**
   * Re-spawn all terminals whose sessions are no longer active (e.g. after
   * a Kubernetes reconnect). Skips user-deleted terminals and terminals that
   * are already running.
   */
  async rehydrate(): Promise<void> {
    const terminals = Array.from(this.terminals.values());
    await Promise.all(
      terminals.map(async (terminal) => {
        const sessionId = makePtySessionId(terminal.projectId, terminal.taskId, terminal.id);
        if (this.sessions.has(sessionId)) return;
        await this.spawnTerminal(terminal).catch((e) => {
          log.error('K8sTerminalProvider: rehydrate failed', {
            terminalId: terminal.id,
            error: String(e),
          });
        });
      })
    );
  }

  async killTerminal(terminalId: string): Promise<void> {
    const sessionId = makePtySessionId(this.projectId, this.scopeId, terminalId);
    this.knownSessionIds.delete(sessionId);
    const pty = this.sessions.get(sessionId);
    if (pty) {
      try {
        pty.kill();
      } catch {}
      this.sessions.delete(sessionId);
      ptySessionRegistry.unregister(sessionId);
    }
    this.terminals.delete(terminalId);
    this.shellProfiles.delete(sessionId);
    if (this.tmuxSessions.delete(sessionId)) {
      await killTmuxSession(this.ctx, makeTmuxSessionName(sessionId));
    }
  }

  async destroyAll(): Promise<void> {
    kubeConnectionManager.off('connection-event', this._handleReconnect);
    const tmuxSessionIds = Array.from(this.tmuxSessions);
    await this.detachAll();
    await Promise.all(
      tmuxSessionIds.map((id) => killTmuxSession(this.ctx, makeTmuxSessionName(id)))
    );
    this.knownSessionIds.clear();
    this.terminals.clear();
    this.shellProfiles.clear();
    this.tmuxSessions.clear();
  }

  async detachAll(): Promise<void> {
    for (const [sessionId, pty] of this.sessions) {
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(sessionId);
      this.shellProfiles.delete(sessionId);
    }
    this.sessions.clear();
  }
}
