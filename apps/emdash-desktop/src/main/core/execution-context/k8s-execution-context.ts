import {
  buildRemoteShellCommand,
  FALLBACK_REMOTE_SHELL_PROFILE,
  type RemoteShellProfile,
} from '@main/core/execution-context/remote-shell-profile';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { quoteShellArg } from '@main/utils/shellEscape';
import { NON_INTERACTIVE_GIT_ENV } from './non-interactive-git-env';
import type { ExecOptions, ExecResult, IExecutionContext } from './types';

function withNonInteractiveGitEnv(command: string): string {
  if (command !== 'git') return command;
  const envPrefix = Object.entries(NON_INTERACTIVE_GIT_ENV)
    .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
    .join(' ');
  return `${envPrefix} ${command}`;
}

/**
 * Builds the full shell command string to run inside a pod.
 * When `root` is provided the command runs inside `cd root &&`.
 * Args are shell-escaped for safe remote execution.
 */
export function buildK8sCommand(
  root: string | undefined,
  command: string,
  args: string[],
  profile?: RemoteShellProfile
): string {
  const escaped = args.map(quoteShellArg).join(' ');
  const executable = withNonInteractiveGitEnv(command);
  const inner = args.length ? `${executable} ${escaped}` : executable;
  const body = root ? `cd ${quoteShellArg(root)} && ${inner}` : inner;
  return buildRemoteShellCommand(profile ?? FALLBACK_REMOTE_SHELL_PROFILE, body);
}

export class K8sExecutionContext implements IExecutionContext {
  readonly root?: string;
  readonly supportsLocalSpawn = false;

  private readonly _lifetime = new AbortController();

  constructor(
    private readonly proxy: KubeClientProxy,
    opts: { root?: string } = {}
  ) {
    this.root = opts.root;
  }

  async exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const { signal } = opts;
    const profile = await this.proxy.getRemoteShellProfile();
    const full = buildK8sCommand(this.root, command, args, profile);
    const combined = this._signal(signal);

    if (combined.aborted) {
      throw combined.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const result = await this.proxy.exec(full);
    if (combined.aborted) {
      throw combined.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (result.exitCode === 0) {
      return { stdout: result.stdout, stderr: result.stderr };
    }
    throw Object.assign(new Error(result.stderr || `Process exited with code ${result.exitCode}`), {
      stdout: result.stdout,
      stderr: result.stderr,
    });
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
    const full = buildK8sCommand(this.root, command, args, profile);
    const combined = this._signal(signal);
    await this.proxy.execStreaming(full, onChunk, { signal: combined });
  }

  dispose(): void {
    this._lifetime.abort();
  }

  private _signal(callerSignal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [this._lifetime.signal];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }
}
