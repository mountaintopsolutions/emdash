import { eq } from 'drizzle-orm';
import { K8sExecutionContext } from '@main/core/execution-context/k8s-execution-context';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { appSettingsService } from '@main/core/settings/settings-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import { db } from '@main/db/client';
import { k8sConnections } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { IInitializable } from '@main/lib/lifecycle';
import { log } from '@main/lib/logger';
import type {
  DependencyCategory,
  DependencyId,
  DependencyInstallResult,
  DependencyState,
  DependencyStatus,
} from '@shared/dependencies';
import { dependencyStatusUpdatedChannel } from '@shared/events/appEvents';
import { err, ok } from '@shared/result';
import {
  createK8sInstallCommandRunner,
  createLocalInstallCommandRunner,
  createSshInstallCommandRunner,
  type InstallCommandRunner,
} from './install-runner';
import { resolveCommandPath, runVersionProbe } from './probe';
import { DEPENDENCIES, getDependencyDescriptor } from './registry';
import type { DependencyDescriptor, DependencyProbeOptions, ProbeResult } from './types';

const VERSION_RE = /(\d+\.\d+[\d.]*)/;

function resolveProbeStatus(
  descriptor: DependencyDescriptor,
  resolvedPath: string | null,
  probe: ProbeResult
): DependencyStatus {
  if (descriptor.resolveStatus) {
    return descriptor.resolveStatus(probe);
  }
  if (resolvedPath !== null) return 'available';
  if (probe.exitCode !== null && (probe.stdout || probe.stderr)) return 'available';
  if (probe.timedOut && probe.stdout) return 'available';
  return probe.exitCode === null ? 'missing' : 'error';
}

function extractVersion(probe: ProbeResult): string | null {
  const raw = (probe.stdout || probe.stderr).trim();
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  // Extract a version-like token, e.g. "git version 2.39.0" → "2.39.0"
  const m = VERSION_RE.exec(firstLine);
  return m ? m[1] : firstLine || null;
}

function dependencyStateFromProbeResult(
  descriptor: DependencyDescriptor,
  resolvedPath: string | null,
  probe: ProbeResult | null
): DependencyState {
  let status: DependencyStatus;
  let version: string | null = null;

  if (probe === null) {
    status = resolvedPath !== null ? 'available' : 'missing';
  } else {
    status = resolveProbeStatus(descriptor, resolvedPath, probe);
  }

  if (status === 'available' && probe) {
    version = extractVersion(probe);
  }

  return {
    id: descriptor.id,
    category: descriptor.category,
    status,
    version,
    path: resolvedPath,
    checkedAt: Date.now(),
    error: status === 'error' ? probe?.stderr?.trim() || 'Unknown error' : undefined,
  };
}

export class DependencyManager implements IInitializable {
  private state = new Map<DependencyId, DependencyState>();
  private readonly ctx: IExecutionContext;
  private readonly emitEvents: boolean;
  private readonly runInstallCommand: InstallCommandRunner;
  private readonly connectionId: string | undefined;

  constructor(
    ctx: IExecutionContext,
    {
      emitEvents = true,
      runInstallCommand = createLocalInstallCommandRunner(resolveLocalInstallShellProfile),
      connectionId,
    }: {
      emitEvents?: boolean;
      runInstallCommand?: InstallCommandRunner;
      connectionId?: string;
    } = {}
  ) {
    this.ctx = ctx;
    this.emitEvents = emitEvents;
    this.runInstallCommand = runInstallCommand;
    this.connectionId = connectionId;
  }

  /**
   * Kick off background probing for all dependencies. Returns immediately;
   * results stream in via `dependencyStatusUpdatedChannel` events.
   */
  initialize(): void {
    void this.probeAll();
  }

  getAll(): Map<DependencyId, DependencyState> {
    return new Map(this.state);
  }

  get(id: DependencyId): DependencyState | undefined {
    return this.state.get(id);
  }

  getByCategory(cat: DependencyCategory): DependencyState[] {
    return [...this.state.values()].filter((s) => {
      const desc = getDependencyDescriptor(s.id);
      return desc?.category === cat;
    });
  }

  /**
   * Two-phase probe for a single dependency:
   *   1. Resolve path (fast, ~5ms) — emits an event immediately.
   *   2. Run version probe (slow, up to 10s) — emits a second event on completion.
   */
  async probe(id: DependencyId): Promise<DependencyState> {
    const descriptor = getDependencyDescriptor(id);
    if (!descriptor) {
      throw new Error(`Unknown dependency id: ${id}`);
    }

    // Phase 1: path resolution
    const resolvedPath = await this.resolveFirstPath(descriptor);
    const pathState = dependencyStateFromProbeResult(descriptor, resolvedPath, null);
    this.updateState(pathState);

    if (pathState.status === 'missing') {
      return pathState;
    }

    // Phase 2: version probe
    const versionArgs = descriptor.versionArgs ?? ['--version'];
    const probeResult = await runVersionProbe(
      descriptor.commands[0] ?? id,
      resolvedPath,
      versionArgs,
      this.ctx
    );
    const fullState = dependencyStateFromProbeResult(descriptor, resolvedPath, probeResult);
    this.updateState(fullState);

    return fullState;
  }

  async probeAll(options: DependencyProbeOptions = {}): Promise<void> {
    await this.refreshShellEnvIfRequested(options);
    await Promise.all(
      DEPENDENCIES.map((d) =>
        this.probe(d.id).catch((err) => {
          log.warn(`[DependencyManager] Failed to probe ${d.id}:`, err);
        })
      )
    );
  }

  async probeCategory(
    cat: DependencyCategory,
    options: DependencyProbeOptions = {}
  ): Promise<void> {
    await this.refreshShellEnvIfRequested(options);
    const targets = DEPENDENCIES.filter((d) => d.category === cat);
    await Promise.all(
      targets.map((d) =>
        this.probe(d.id).catch((err) => {
          log.warn(`[DependencyManager] Failed to probe ${d.id}:`, err);
        })
      )
    );
  }

  /**
   * Run the installCommand for a dependency, then re-probe to update state.
   * Returns the updated DependencyState after installation attempt.
   */
  async install(id: DependencyId): Promise<DependencyInstallResult> {
    const descriptor = getDependencyDescriptor(id);
    if (!descriptor) {
      return err({ type: 'unknown-dependency', id });
    }
    if (!descriptor.installCommand) {
      return err({ type: 'no-install-command', id });
    }

    log.info(`[DependencyManager] Installing ${id}: ${descriptor.installCommand}`);

    await this.ctx.refreshShellEnv?.();

    const installResult = await this.runInstallCommand(descriptor.installCommand);
    if (!installResult.success) {
      return err(installResult.error);
    }

    await this.ctx.refreshShellEnv?.();

    const state = await this.probe(id);
    if (state.status !== 'available') {
      return err({ type: 'not-detected-after-install', id });
    }

    return ok(state);
  }

  private async resolveFirstPath(descriptor: DependencyDescriptor): Promise<string | null> {
    for (const command of descriptor.commands) {
      const path = await resolveCommandPath(command, this.ctx);
      if (path) return path;
    }
    return null;
  }

  private async refreshShellEnvIfRequested(options: DependencyProbeOptions = {}): Promise<void> {
    if (options.refreshShellEnv) {
      await this.ctx.refreshShellEnv?.();
    }
  }

  private updateState(state: DependencyState): void {
    this.state.set(state.id, state);
    if (this.emitEvents) {
      events.emit(dependencyStatusUpdatedChannel, {
        id: state.id,
        state,
        connectionId: this.connectionId,
      });
    }
  }
}

async function resolveLocalInstallShellProfile() {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: defaultShell,
    onFallback: (error) => {
      log.warn('[DependencyManager] Preferred install shell unavailable, using fallback', {
        shell: error.shell,
        target: error.target,
      });
    },
  });
}

export const localDependencyManager = new DependencyManager(new LocalExecutionContext());

const sshManagers = new Map<string, DependencyManager>();
const k8sManagers = new Map<string, DependencyManager>();

async function isK8sConnection(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: k8sConnections.id })
    .from(k8sConnections)
    .where(eq(k8sConnections.id, connectionId))
    .limit(1);
  return row !== undefined;
}

async function getK8sDependencyManager(connectionId: string): Promise<DependencyManager> {
  let mgr = k8sManagers.get(connectionId);
  if (!mgr) {
    const proxy = await kubeConnectionManager.connect(connectionId);
    mgr = new DependencyManager(new K8sExecutionContext(proxy), {
      emitEvents: true,
      runInstallCommand: createK8sInstallCommandRunner(proxy),
      connectionId,
    });
    k8sManagers.set(connectionId, mgr);
  }
  return mgr;
}

async function getSshDependencyManager(connectionId: string): Promise<DependencyManager> {
  let mgr = sshManagers.get(connectionId);
  if (!mgr) {
    const proxy = await sshConnectionManager.connect(connectionId);
    mgr = new DependencyManager(new SshExecutionContext(proxy), {
      emitEvents: true,
      runInstallCommand: createSshInstallCommandRunner(proxy),
      connectionId,
    });
    sshManagers.set(connectionId, mgr);
  }
  return mgr;
}

export async function getDependencyManager(connectionId?: string): Promise<DependencyManager> {
  if (!connectionId) return localDependencyManager;
  // Fast path: a manager built for this id is already transport-correct, so
  // skip the connection-type DB lookup entirely.
  const cached = k8sManagers.get(connectionId) ?? sshManagers.get(connectionId);
  if (cached) return cached;
  // The k8s and ssh connection id-spaces are disjoint tables, so look up k8s
  // first: a hit means this is a k8s project, otherwise fall back to SSH.
  if (await isK8sConnection(connectionId)) {
    return getK8sDependencyManager(connectionId);
  }
  return getSshDependencyManager(connectionId);
}
