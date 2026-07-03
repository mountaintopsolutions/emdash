import { PassThrough, Writable } from 'node:stream';
import { Exec, type KubeConfig } from '@kubernetes/client-node';
import {
  captureRemoteShellProfile,
  DEFAULT_REMOTE_SHELL,
  type RemoteShellExecChannel,
  type RemoteShellExecClient,
  type RemoteShellProfile,
} from '@main/core/execution-context/remote-shell-profile';
import type { ExecResult } from '@shared/kubernetes';
import type { KubeTarget } from '../connect/resolve-kube-connect-config';

/**
 * The web socket type returned by `Exec.exec`. `@kubernetes/client-node` does
 * not re-export it, so derive it from the method's return type rather than
 * depending on the transitive `isomorphic-ws` package directly.
 */
type WebSocket = Awaited<ReturnType<Exec['exec']>>;

/**
 * Live transport bound to a single connected pod. Created on update() and torn
 * down on invalidate().
 */
interface KubeTransport {
  kc: KubeConfig;
  exec: Exec;
  target: KubeTarget;
}

type RemoteShellProfileState =
  | { kind: 'empty' }
  | {
      kind: 'loading';
      transport: KubeTransport;
      mode: 'get' | 'refresh';
      promise: Promise<RemoteShellProfile>;
    }
  | { kind: 'ready'; transport: KubeTransport; profile: RemoteShellProfile };

/**
 * Options describing a PTY-style exec session.
 */
export interface KubePtyOptions {
  cols: number;
  rows: number;
}

/**
 * A live interactive exec session. The PTY layer (task #7) consumes this handle
 * to forward data, resize the terminal, and tear the session down. Mirrors the
 * duplex channel that ssh2's exec returns.
 */
export interface KubePtyHandle {
  /** Forward bytes to the pod's stdin. */
  write(data: string): void;
  /** Subscribe to stdout/stderr bytes coming from the pod. */
  onData(listener: (chunk: string) => void): void;
  /** Subscribe to session close. exitCode is null when unknown. */
  onClose(listener: (exitCode: number | null) => void): void;
  /** Resize the remote TTY. */
  resize(cols: number, rows: number): void;
  /** Terminate the session. */
  kill(): void;
}

/**
 * Stable reference to a Kubernetes exec transport that survives reconnects.
 *
 * Mirrors SshClientProxy: services hold a KubeClientProxy rather than a raw
 * KubeConfig/Exec. KubeConnectionManager calls update() whenever a connection
 * is (re)established and invalidate() when it drops, so callers that access the
 * proxy at call time always reach the current live transport.
 */
export class KubeClientProxy {
  private _transport: KubeTransport | null = null;
  private _remoteShellProfileState: RemoteShellProfileState = { kind: 'empty' };

  constructor(
    readonly connectionId: string,
    private healthReporter?: { reportChannelError(connectionId: string, error: unknown): void }
  ) {}

  /** Called by KubeConnectionManager when a connection becomes ready. */
  update(kc: KubeConfig, target: KubeTarget): void {
    this._transport = { kc, exec: new Exec(kc), target };
    this._remoteShellProfileState = { kind: 'empty' };
  }

  /** Called by KubeConnectionManager when the connection drops. */
  invalidate(): void {
    this._transport = null;
    this._remoteShellProfileState = { kind: 'empty' };
  }

  /** True while an active transport is held. */
  get isConnected(): boolean {
    return this._transport !== null;
  }

  /** The pod this proxy targets. Throws when disconnected. */
  get target(): KubeTarget {
    return this.transport.target;
  }

  /**
   * The live KubeConfig backing this connection. Throws when disconnected,
   * like `target`. Used by the port-forward tunnel to construct a PortForward
   * bound to the current transport's API server.
   */
  get kubeConfig(): KubeConfig {
    return this.transport.kc;
  }

  private get transport(): KubeTransport {
    if (!this._transport) {
      throw new Error('Kubernetes connection is not available');
    }
    return this._transport;
  }

  // ─── Remote shell profile (shared machinery with SSH) ──────────────────────

  async getRemoteShellProfile(): Promise<RemoteShellProfile> {
    const transport = this.transport;
    const state = this._remoteShellProfileState;

    if (state.kind === 'ready' && state.transport === transport) {
      return state.profile;
    }
    if (state.kind === 'loading' && state.transport === transport) {
      return state.promise;
    }

    return this.captureRemoteShellProfileFor(transport, 'get');
  }

  async refreshRemoteShellProfile(): Promise<RemoteShellProfile> {
    const transport = this.transport;
    const state = this._remoteShellProfileState;

    if (state.kind === 'loading' && state.transport === transport && state.mode === 'refresh') {
      return state.promise;
    }

    return this.captureRemoteShellProfileFor(transport, 'refresh');
  }

  private captureRemoteShellProfileFor(
    transport: KubeTransport,
    mode: 'get' | 'refresh'
  ): Promise<RemoteShellProfile> {
    const promise = captureRemoteShellProfile(this.remoteShellExecClient(transport)).then(
      (profile) => {
        if (
          this._transport === transport &&
          this._remoteShellProfileState.kind === 'loading' &&
          this._remoteShellProfileState.promise === promise
        ) {
          this._remoteShellProfileState = { kind: 'ready', transport, profile };
        }
        return profile;
      }
    );
    this._remoteShellProfileState = { kind: 'loading', transport, mode, promise };
    return promise;
  }

  /**
   * Adapts the async exec transport onto the ssh2-style callback client that
   * captureRemoteShellProfile expects. The command is the already-built shell
   * string and is run as `/bin/sh -c <command>` inside the pod.
   */
  private remoteShellExecClient(transport: KubeTransport): RemoteShellExecClient {
    return {
      exec: (command, callback) => {
        const stdoutChannel = new PassThrough();
        const stderrChannel = new PassThrough();
        const adapter: RemoteShellExecChannel = {
          on: (event: string, handler: (value: never) => void) => {
            stdoutChannel.on(event, handler as (value: unknown) => void);
            return adapter;
          },
          stderr: {
            on: (event: string, handler: (value: never) => void) => {
              stderrChannel.on(event, handler as (value: unknown) => void);
              return stderrChannel;
            },
          },
          destroy: () => {
            stdoutChannel.destroy();
            stderrChannel.destroy();
          },
        } as RemoteShellExecChannel;

        callback(undefined, adapter);

        this.runExec([DEFAULT_REMOTE_SHELL, '-c', command], transport)
          .then(({ stdout, stderr, exitCode }) => {
            if (stdout) stdoutChannel.write(stdout);
            if (stderr) stderrChannel.write(stderr);
            stdoutChannel.emit('close', exitCode);
          })
          .catch((error: unknown) => {
            stdoutChannel.emit('error', error instanceof Error ? error : new Error(String(error)));
          });
      },
    };
  }

  // ─── Command execution ─────────────────────────────────────────────────────

  /**
   * Run a fully-built shell command string non-interactively, buffering stdout,
   * stderr, and the resulting exit code. The command is executed as
   * `/bin/sh -c <command>` inside the target container.
   */
  async exec(command: string): Promise<ExecResult> {
    return this.runExec([DEFAULT_REMOTE_SHELL, '-c', command], this.transport);
  }

  // ─── Binary file transfer (the SFTP-equivalent) ─────────────────────────────

  /**
   * Stream the raw bytes of a file inside the pod into a buffer. Runs `cat`
   * with `tty:false` so the multiplexed stdout stream is delivered verbatim
   * (no terminal translation), making it safe for binary content such as
   * images. Both the SSH filesystem's SFTP reads and this method exist to read
   * bytes the buffered, UTF-8 `exec()` path would corrupt.
   *
   * `remotePath` is an absolute POSIX path inside the container.
   *
   * `maxBytes`, when set, caps how many bytes are accumulated (and transferred)
   * — once enough bytes have arrived the exec WebSocket is closed so a huge file
   * is never buffered or transferred in full. The resolved buffer is at most
   * `maxBytes` long. Mirrors the size-bounded reads the SSH filesystem performs
   * via SFTP streaming.
   */
  async readFileBytes(remotePath: string, maxBytes?: number): Promise<Buffer> {
    const { exec, target } = this.transport;
    const argv = ['cat', remotePath];

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let accumulated = 0;
      let settled = false;
      let exitCode = 0;
      let statusSeen = false;
      let socket: WebSocket | null = null;
      let capped = false;

      const stdoutStream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (capped) {
            done();
            return;
          }
          // Once we've hit the cap, trim the trailing bytes, stop accepting,
          // and tear down the exec stream so the rest of a large file is
          // neither transferred nor buffered.
          if (maxBytes !== undefined && accumulated + chunk.length >= maxBytes) {
            const remaining = maxBytes - accumulated;
            if (remaining > 0) {
              chunks.push(Buffer.from(chunk.subarray(0, remaining)));
              accumulated = maxBytes;
            }
            capped = true;
            socket?.close();
            done();
            return;
          }
          chunks.push(Buffer.from(chunk));
          accumulated += chunk.length;
          done();
        },
      });
      const stderrStream = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });

      const finish = (result: Buffer | Error) => {
        if (settled) return;
        settled = true;
        if (result instanceof Error) {
          this.reportChannelResult(result);
          reject(result);
          return;
        }
        resolve(result);
      };

      exec
        .exec(
          target.namespace,
          target.podName,
          target.containerName ?? '',
          argv,
          stdoutStream,
          stderrStream,
          null,
          false,
          (status) => {
            statusSeen = true;
            exitCode = exitCodeFromStatus(status);
          }
        )
        .then((ws: WebSocket) => {
          socket = ws;
          // If the cap was reached before the socket was assigned, close it now
          // so the pod stops streaming the remainder.
          if (capped) ws.close();
          ws.on('close', () => {
            if (statusSeen && exitCode !== 0) {
              finish(new Error(`Failed to read ${remotePath} (exit code ${exitCode})`));
              return;
            }
            finish(Buffer.concat(chunks));
          });
          ws.on('error', (error: unknown) => {
            finish(error instanceof Error ? error : new Error(String(error)));
          });
        })
        .catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Write raw bytes to a file inside the pod by piping them to a non-TTY exec
   * session's stdin. The caller supplies the already-built, shell-quoted
   * redirection command (e.g. `cat > '/abs/path'`); we run it as
   * `/bin/sh -c <command>` and stream `data` to stdin. tty=false keeps the byte
   * stream verbatim, mirroring the SSH filesystem's SFTP fastPut for binary
   * content. Resolves on a clean, zero-exit close.
   */
  async writeFileBytes(command: string, data: Buffer): Promise<void> {
    const { exec, target } = this.transport;
    const argv = [DEFAULT_REMOTE_SHELL, '-c', command];

    return new Promise<void>((resolve, reject) => {
      const stdin = new PassThrough();
      let settled = false;
      let exitCode = 0;
      let statusSeen = false;
      let stderr = '';

      const stdoutStream = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      const stderrStream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          stderr += chunk.toString('utf-8');
          done();
        },
      });

      exec
        .exec(
          target.namespace,
          target.podName,
          target.containerName ?? '',
          argv,
          stdoutStream,
          stderrStream,
          stdin,
          false,
          (status) => {
            statusSeen = true;
            exitCode = exitCodeFromStatus(status);
          }
        )
        .then((socket: WebSocket) => {
          stdin.end(data);
          socket.on('close', () => {
            if (settled) return;
            settled = true;
            if (statusSeen && exitCode !== 0) {
              reject(new Error(`Failed to write file (exit code ${exitCode}): ${stderr.trim()}`));
              return;
            }
            resolve();
          });
          socket.on('error', (error: unknown) => {
            if (settled) return;
            settled = true;
            this.reportChannelResult(error);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          this.reportChannelResult(error);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Run a fully-built shell command string non-interactively, streaming stdout
   * chunks to `onChunk`. Returning false from `onChunk` ends the session early.
   * Resolves when the session closes; rejects when `signal` aborts.
   */
  execStreaming(
    command: string,
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const { exec, target } = this.transport;
    const { signal } = opts;
    const argv = [DEFAULT_REMOTE_SHELL, '-c', command];

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      let settled = false;
      let socket: WebSocket | null = null;

      const stdoutStream = new Writable({
        write: (chunk, _encoding, done) => {
          if (!settled && !onChunk(chunk.toString('utf-8'))) {
            socket?.close();
          }
          done();
        },
      });
      const stderrStream = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });

      const onAbort = () => {
        if (settled) return;
        settled = true;
        socket?.close();
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          this.reportChannelResult(error);
          reject(error);
        } else {
          resolve();
        }
      };

      exec
        .exec(
          target.namespace,
          target.podName,
          target.containerName ?? '',
          argv,
          stdoutStream,
          stderrStream,
          null,
          false
        )
        .then((ws: WebSocket) => {
          socket = ws;
          ws.on('close', () => finish());
          ws.on('error', (error: unknown) =>
            finish(error instanceof Error ? error : new Error(String(error)))
          );
        })
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error)))
        );
    });
  }

  private runExec(argv: string[], transport: KubeTransport): Promise<ExecResult> {
    const { exec, target } = transport;
    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let statusSeen = false;
      let settled = false;

      const stdoutStream = new Writable({
        write(chunk, _encoding, done) {
          stdout += chunk.toString('utf-8');
          done();
        },
      });
      const stderrStream = new Writable({
        write(chunk, _encoding, done) {
          stderr += chunk.toString('utf-8');
          done();
        },
      });

      const settle = () => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode });
      };

      exec
        .exec(
          target.namespace,
          target.podName,
          target.containerName ?? '',
          argv,
          stdoutStream,
          stderrStream,
          null,
          false,
          (status) => {
            statusSeen = true;
            exitCode = exitCodeFromStatus(status);
          }
        )
        .then((socket: WebSocket) => {
          socket.on('close', () => {
            // If no status callback arrived, treat a clean socket close as
            // success; otherwise honor the captured exit code.
            if (!statusSeen) exitCode = 0;
            settle();
          });
          socket.on('error', (error: unknown) => {
            if (settled) return;
            settled = true;
            this.reportChannelResult(error);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          this.reportChannelResult(error);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  // ─── Interactive (PTY) execution ───────────────────────────────────────────

  /**
   * Open an interactive TTY exec session running the given argv inside the
   * target container, returning a handle the PTY layer drives. tty=true is sent
   * so the pod allocates a terminal.
   */
  execPty(argv: string[], options: KubePtyOptions): KubePtyHandle {
    const { exec, target } = this.transport;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const dataListeners: Array<(chunk: string) => void> = [];
    const closeListeners: Array<(exitCode: number | null) => void> = [];
    let socket: WebSocket | null = null;
    let exitCode: number | null = null;

    // Resize coalescing: keep only the latest requested size and flush it on a
    // short timer so a drag sends ~one frame per window instead of dozens.
    let pendingResize: { cols: number; rows: number } | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushResize = () => {
      resizeTimer = null;
      if (socket && pendingResize) {
        sendResize(socket, pendingResize.cols, pendingResize.rows);
        pendingResize = null;
      }
    };
    const clearResizeTimer = () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    };

    const emitData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const listener of dataListeners) listener(text);
    };
    stdout.on('data', emitData);
    stderr.on('data', emitData);

    const emitClose = () => {
      for (const listener of closeListeners) listener(exitCode);
    };

    exec
      .exec(
        target.namespace,
        target.podName,
        target.containerName ?? '',
        argv,
        stdout,
        stderr,
        stdin,
        true,
        (status) => {
          exitCode = exitCodeFromStatus(status);
        }
      )
      .then((ws: WebSocket) => {
        socket = ws;
        // Send the initial terminal size once the channel is open. A resize that
        // arrived before the channel opened is flushed here so it isn't lost.
        sendResize(ws, options.cols, options.rows);
        if (pendingResize) flushResize();
        // Keep the exec stream alive while idle. The Kubernetes API server (and
        // any proxy in front of it, e.g. Teleport) closes idle exec WebSockets,
        // which would kill a waiting agent/terminal session. This is the k8s
        // analog of SSH's ServerAliveInterval.
        const wsPing = ws as unknown as { ping?: () => void };
        const keepAlive = setInterval(() => {
          try {
            wsPing.ping?.();
          } catch {
            // best-effort; the close handler performs cleanup
          }
        }, PTY_KEEPALIVE_INTERVAL_MS);
        const stopKeepAlive = () => clearInterval(keepAlive);
        ws.on('close', () => {
          stopKeepAlive();
          clearResizeTimer();
          emitClose();
        });
        ws.on('error', (error: unknown) => {
          stopKeepAlive();
          this.reportChannelResult(error);
        });
      })
      .catch((error: unknown) => {
        this.reportChannelResult(error);
        emitClose();
      });

    return {
      write: (data: string) => {
        stdin.write(data);
      },
      onData: (listener) => {
        dataListeners.push(listener);
      },
      onClose: (listener) => {
        closeListeners.push(listener);
      },
      resize: (cols: number, rows: number) => {
        // Coalesce: remember the latest size and flush on a short timer so a
        // drag collapses into ~one frame per window instead of a SIGWINCH storm.
        pendingResize = { cols, rows };
        if (!resizeTimer) resizeTimer = setTimeout(flushResize, RESIZE_COALESCE_MS);
      },
      kill: () => {
        clearResizeTimer();
        stdin.end();
        socket?.close();
      },
    };
  }

  // ─── Health reporting ──────────────────────────────────────────────────────

  private reportChannelResult(error: unknown): void {
    if (error) {
      this.healthReporter?.reportChannelError(this.connectionId, error);
    }
  }
}

/**
 * Resolves a process exit code from a V1Status returned by the exec status
 * callback. 'Success' is exit 0; failures encode the code in
 * details.causes[reason=ExitCode].
 */
function exitCodeFromStatus(status: unknown): number {
  const value = status as
    | {
        status?: string;
        details?: { causes?: Array<{ reason?: string; message?: string }> };
      }
    | undefined;
  if (value?.status === 'Success') return 0;
  const cause = value?.details?.causes?.find((entry) => entry.reason === 'ExitCode');
  const parsed = cause?.message ? Number.parseInt(cause.message, 10) : Number.NaN;
  return Number.isNaN(parsed) ? 1 : parsed;
}

/**
 * The exec stream multiplexes channels by a single leading byte:
 * 0=stdin, 1=stdout, 2=stderr, 3=error, 4=resize. Resize frames carry a JSON
 * terminal-size message ({ Width, Height }) on channel 4.
 */
const RESIZE_CHANNEL = 4;

/** Ping interval for interactive exec streams so idle sessions aren't reaped. */
const PTY_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Coalesce window for resize frames. A pane drag fires a resize per pixel; sent
 * raw, the channel-4 frames flood the exec WebSocket — tmux thrashes on the
 * SIGWINCH storm and stdin frames queue behind them (input appears to hang).
 * Throttling to the latest size keeps tmux stable and stdin responsive.
 */
const RESIZE_COALESCE_MS = 80;

function sendResize(socket: WebSocket, cols: number, rows: number): void {
  try {
    const payload = JSON.stringify({ Width: cols, Height: rows });
    const frame = Buffer.concat([Buffer.from([RESIZE_CHANNEL]), Buffer.from(payload, 'utf-8')]);
    socket.send(frame);
  } catch {
    // Resize is best-effort; ignore failures (socket may be mid-close).
  }
}
