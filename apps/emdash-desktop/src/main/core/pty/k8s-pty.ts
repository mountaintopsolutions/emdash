import { err, ok, type Result } from '@emdash/shared';
import { DEFAULT_REMOTE_SHELL } from '@main/core/execution-context/remote-shell-profile';
import type { KubeClientProxy, KubePtyHandle } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { Pty, PtyDimensions, PtyExitInfo } from './pty';

export type K8sOpenError = {
  readonly kind: 'channel-open-failed';
  readonly message: string;
};

export interface K8sSpawnOptions extends PtyDimensions {
  id: string;
  command: string;
}

/**
 * A Pty backed by a Kubernetes exec TTY session.
 *
 * Mirrors Ssh2PtySession: wraps the duplex handle returned by
 * KubeClientProxy.execPty and adapts it to the transport-neutral Pty
 * interface. There is no getPid() because the process runs inside the pod.
 */
export class K8sPtySession implements Pty {
  readonly id: string;

  constructor(
    id: string,
    private readonly handle: KubePtyHandle
  ) {
    this.id = id;
  }

  write(data: string): void {
    this.handle.write(data);
  }

  resize(cols: number, rows: number): void {
    this.handle.resize(cols, rows);
  }

  kill(): void {
    this.handle.kill();
  }

  onData(handler: (data: string) => void): void {
    this.handle.onData(handler);
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    // KubePtyHandle reports the in-pod process exit code (null when unknown);
    // there is no remote signal channel, so signal is always undefined. Mirrors
    // the PtyExitInfo shape Ssh2PtySession emits from its 'close' event.
    this.handle.onClose((exitCode: number | null) => {
      handler({ exitCode: exitCode ?? undefined, signal: undefined });
    });
  }
}

/**
 * Open an interactive PTY inside the target pod.
 *
 * Mirrors openSsh2Pty: the command string is run as `/bin/sh -c <command>` in
 * the container with a TTY allocated. KubeClientProxy.execPty does not fail
 * synchronously (errors surface asynchronously through the handle and the
 * health reporter), so this resolves ok unless constructing the session throws.
 */
export async function openK8sPty(
  proxy: KubeClientProxy,
  options: K8sSpawnOptions
): Promise<Result<K8sPtySession, K8sOpenError>> {
  const { id, command, cols, rows } = options;
  try {
    const handle = proxy.execPty([DEFAULT_REMOTE_SHELL, '-c', command], { cols, rows });
    return ok(new K8sPtySession(id, handle));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ kind: 'channel-open-failed', message });
  }
}
