import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type {
  AcpFs,
  AcpProcessHandle,
  AcpProcessHost,
  AcpTerminalExit,
  AcpTerminalProcess,
} from '@emdash/core/acp';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { resolveAgentExecutable } from '@main/core/conversations/impl/resolve-agent-executable';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import {
  buildK8sCommand,
  K8sExecutionContext,
} from '@main/core/execution-context/k8s-execution-context';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import { K8sFileSystem } from '@main/core/runtime/legacy/k8s-legacy-fs';
import { quoteShellArg } from '@main/utils/shellEscape';

// ---------------------------------------------------------------------------
// K8sChannelHandle: wraps a KubeExecProcessHandle as an AcpProcessHandle
// ---------------------------------------------------------------------------

class K8sChannelHandle implements AcpProcessHandle {
  private _exitCode: number | null = null;

  constructor(private readonly handle: ReturnType<KubeClientProxy['execProcess']>) {}

  get stdin(): Writable {
    return this.handle.stdin;
  }

  get stdout(): Readable {
    return this.handle.stdout;
  }

  get stderr(): Readable | undefined {
    return this.handle.stderr;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  onExit(cb: (code: number | null) => void): void {
    this.handle.onExit((code) => {
      this._exitCode = code;
      cb(code);
    });
  }

  onError(cb: (err: Error) => void): void {
    this.handle.onError(cb);
  }

  kill(_signal?: NodeJS.Signals): void {
    this.handle.kill();
  }
}

// ---------------------------------------------------------------------------
// K8sExecTerminalProcess: wraps a KubeExecProcessHandle as AcpTerminalProcess
// ---------------------------------------------------------------------------

class K8sExecTerminalProcess extends EventEmitter implements AcpTerminalProcess {
  private _exitCode: number | null = null;

  constructor(private readonly handle: ReturnType<KubeClientProxy['execProcess']>) {
    super();
    this.handle.onExit((code) => {
      this._exitCode = code;
      this.emit('exit', {
        exitCode: code,
        signal: null,
      } satisfies AcpTerminalExit);
    });
    this.handle.onError((err: Error) => this.emit('error', err));
  }

  get stdout(): Readable {
    return this.handle.stdout;
  }

  get stderr(): Readable | undefined {
    return this.handle.stderr;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  onExit(cb: (status: AcpTerminalExit) => void): void {
    this.on('exit', cb);
  }

  onError(cb: (err: Error) => void): void {
    this.on('error', cb);
  }

  kill(_signal?: NodeJS.Signals): void {
    this.handle.kill();
  }
}

// ---------------------------------------------------------------------------
// K8sAcpFs: adapts K8sFileSystem to the AcpFs interface
// ---------------------------------------------------------------------------

class K8sAcpFs implements AcpFs {
  private readonly k8sFs: K8sFileSystem;

  constructor(proxy: KubeClientProxy) {
    this.k8sFs = new K8sFileSystem(proxy, '/');
  }

  async readFile(filePath: string, _encoding: 'utf8'): Promise<string> {
    const result = await this.k8sFs.read(filePath, Infinity);
    return result.content;
  }

  async writeFile(filePath: string, content: string, _encoding: 'utf8'): Promise<void> {
    await this.k8sFs.write(filePath, content);
  }

  async mkdir(dirPath: string, opts: { recursive: boolean }): Promise<unknown> {
    await this.k8sFs.mkdir(dirPath, opts);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// LegacyK8sAcpProcessHost
// ---------------------------------------------------------------------------

/**
 * ACP process host that runs the agent over an existing Kubernetes connection.
 * Uses a non-TTY exec channel (via KubeClientProxy.execProcess) so that
 * stdin/stdout are framed cleanly for JSON-RPC.
 *
 * Mirrors LegacySshAcpProcessHost: the only transport difference is the proxy
 * type and the command builder (buildK8sCommand vs buildSshCommand).
 */
export class LegacyK8sAcpProcessHost implements AcpProcessHost {
  readonly fs: AcpFs;

  constructor(private readonly proxy: KubeClientProxy) {
    this.fs = new K8sAcpFs(proxy);
  }

  async resolveSpawnContext(
    providerId: string
  ): Promise<{ cli: string; agentEnv: Record<string, string> }> {
    const rawEnv = buildAgentEnv({ agentApiVars: true });
    const filteredEnv = Object.fromEntries(
      Object.entries(rawEnv).filter((e): e is [string, string] => e[1] !== undefined)
    );

    const plugin = getPlugin(providerId);
    const binaryName = plugin.capabilities.hostDependency.binaryNames[0] ?? providerId;

    const cli = await resolveAgentExecutable({
      providerId,
      binaryName,
      ctx: new K8sExecutionContext(this.proxy),
      hostDependencyStore,
      connectionId: this.proxy.connectionId,
    });

    return { cli, agentEnv: filteredEnv };
  }

  async spawn(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpProcessHandle> {
    const profile = await this.proxy.getRemoteShellProfile();

    const envPrefix = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${quoteShellArg(v)}`)
      .join(' ');

    const argsStr = spec.args.map(quoteShellArg).join(' ');
    const innerCmd = envPrefix
      ? `${envPrefix} ${spec.command} ${argsStr}`.trimEnd()
      : `${spec.command} ${argsStr}`.trimEnd();

    const fullCmd = buildK8sCommand(spec.cwd, innerCmd, [], profile);

    const handle = this.proxy.execProcess(['/bin/sh', '-c', fullCmd]);
    return new K8sChannelHandle(handle);
  }

  async spawnTerminal(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpTerminalProcess> {
    const profile = await this.proxy.getRemoteShellProfile();

    const envPrefix = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${quoteShellArg(v)}`)
      .join(' ');

    const argsStr = spec.args.map(quoteShellArg).join(' ');
    const innerCmd = envPrefix
      ? `${envPrefix} ${spec.command} ${argsStr}`.trimEnd()
      : `${spec.command} ${argsStr}`.trimEnd();

    const fullCmd = buildK8sCommand(spec.cwd, innerCmd, [], profile);

    const handle = this.proxy.execProcess(['/bin/sh', '-c', fullCmd]);
    return new K8sExecTerminalProcess(handle);
  }
}
