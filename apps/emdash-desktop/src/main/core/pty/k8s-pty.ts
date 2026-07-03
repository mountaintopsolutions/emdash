import { err, ok, type Result } from '@emdash/shared';
import {
  buildRemoteShellCommand,
  FALLBACK_REMOTE_SHELL_PROFILE,
  type RemoteShellProfile,
} from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { log } from '@main/lib/logger';
import type { Pty, PtyDimensions, PtyExitInfo } from './pty';

export type K8sPtyOpenError = {
  readonly kind: 'channel-open-failed';
  readonly message: string;
};

export interface K8sSpawnOptions extends PtyDimensions {
  id: string;
  command: string;
}

/**
 * Adapts KubeClientProxy.execPty's KubePtyHandle to the desktop Pty interface.
 *
 * The k8s exec WebSocket is fundamentally the same channel as SSH's exec stream
 * — both multiplex stdin/stdout/stderr/resize — so the adaptation is a thin
 * mapping of method names. The handle's keepalive ping (set up in
 * KubeClientProxy.execPty) prevents idle exec WebSockets from being reaped by
 * API servers or proxies like Teleport.
 */
export class K8sPtySession implements Pty {
  readonly id: string;
  private closed = false;

  constructor(
    id: string,
    private readonly handle: Awaited<ReturnType<KubeClientProxy['execPty']>>
  ) {
    this.id = id;
  }

  write(data: string): void {
    if (this.closed) return;
    this.handle.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    try {
      this.handle.resize(cols, rows);
    } catch (err: unknown) {
      log.warn('K8sPtySession:resize failed', {
        cols,
        rows,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  kill(): void {
    this.closed = true;
    try {
      this.handle.kill();
    } catch {}
  }

  onData(handler: (data: string) => void): void {
    this.handle.onData(handler);
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    this.handle.onClose((exitCode: number | null) => {
      handler({ exitCode: exitCode ?? undefined });
    });
  }
}

/**
 * Open an interactive PTY session in the pod, running the given command string
 * (already built with shell profile applied) via `/bin/sh -c`.
 *
 * The profile is applied outside this function (by the terminal provider) so
 * the command arriving here is the full shell string, same as `openSsh2Pty`.
 */
export async function openK8sPty(
  proxy: KubeClientProxy,
  options: K8sSpawnOptions,
  profile?: RemoteShellProfile
): Promise<Result<K8sPtySession, K8sPtyOpenError>> {
  const { id, command, cols, rows } = options;
  try {
    const fullCommand = buildRemoteShellCommand(profile ?? FALLBACK_REMOTE_SHELL_PROFILE, command);
    const handle = proxy.execPty(['/bin/sh', '-c', fullCommand], { cols, rows });
    return ok(new K8sPtySession(id, handle));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ kind: 'channel-open-failed', message });
  }
}
