import {
  buildRemoteShellCommand,
  FALLBACK_REMOTE_SHELL_PROFILE,
  type RemoteShellProfile,
} from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { getGitExecutable } from '@main/core/utils/exec';
import { quoteShellArg } from '@main/utils/shellEscape';
import { NON_INTERACTIVE_GIT_ENV } from './non-interactive-git-env';
import type { ExecOptions, ExecResult, IExecutionContext } from './types';

function withNonInteractiveGitEnv(command: string, gitExecutable?: string): string {
  if (command !== 'git') return command;
  const envPrefix = Object.entries(NON_INTERACTIVE_GIT_ENV)
    .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
    .join(' ');
  return `${envPrefix} ${quoteShellArg(gitExecutable ?? command)}`;
}

/**
 * Builds the full shell command string to send to the pod.
 * When `root` is provided the command runs inside `cd root &&`.
 * Args are shell-escaped for safe remote execution.
 */
export function buildK8sCommand(
  root: string | undefined,
  command: string,
  args: string[],
  profile?: RemoteShellProfile,
  gitExecutable?: string
): string {
  const escaped = args.map(quoteShellArg).join(' ');
  const executable = withNonInteractiveGitEnv(command, gitExecutable);
  const inner = args.length ? `${executable} ${escaped}` : executable;
  const body = root ? `cd ${quoteShellArg(root)} && ${inner}` : inner;
  return buildRemoteShellCommand(profile ?? FALLBACK_REMOTE_SHELL_PROFILE, body);
}

/**
 * Kubernetes execution context. Runs commands inside a pod via
 * KubeClientProxy.exec/execStreaming. Mirrors SshExecutionContext but uses
 * the proxy's Promise-based API instead of ssh2's callback-style streams.
 */
export class K8sExecutionContext implements IExecutionContext {
  readonly root?: string;
  readonly supportsLocalSpawn = false;

  private readonly _lifetime = new AbortController();

  constructor(
    private readonly proxy: KubeClientProxy,
    private readonly contextOptions: { root?: string; connectionId?: string } = {}
  ) {
    this.root = contextOptions.root;
  }

  async exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const { signal } = opts;
    const profile = await this.proxy.getRemoteShellProfile();
    const full = buildK8sCommand(this.root, command, args, profile, this.gitExecutableFor(command));
    const combined = this._signal(signal);

    if (combined.aborted) {
      throw combined.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const result = await this.proxy.exec(full);
    if (result.exitCode !== 0) {
      throw Object.assign(
        new Error(result.stderr || `Process exited with code ${result.exitCode}`),
        {
          stdout: result.stdout,
          stderr: result.stderr,
        }
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async refreshShellEnv(): Promise<void> {
    await this.proxy.refreshRemoteShellProfile();
  }

  async execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const { signal } = opts;
    const profile = await this.proxy.getRemoteShellProfile();
    const full = buildK8sCommand(this.root, command, args, profile, this.gitExecutableFor(command));
    const combined = this._signal(signal);

    return this.proxy.execStreaming(full, onChunk, { signal: combined });
  }

  dispose(): void {
    this._lifetime.abort();
  }

  private gitExecutableFor(command: string): string | undefined {
    if (command !== 'git' || !this.contextOptions.connectionId) return undefined;
    return getGitExecutable(this.contextOptions.connectionId);
  }

  private _signal(callerSignal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [this._lifetime.signal];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }
}
