import net from 'node:net';
import { type KubeConfig, PortForward } from '@kubernetes/client-node';
import type { ClientChannel } from 'ssh2';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';

const LOCAL_BIND_HOST = '127.0.0.1';
// A dev server may bind to the IPv4 loopback, the IPv6 loopback, or both. A
// process started on the default `localhost` host resolves to `::1` first on
// Node >= 17, so it often listens only on `[::1]`. Dialing a single hardcoded
// `127.0.0.1` misses it. Try both loopback families per connection, in order,
// and forward through whichever one the remote accepts.
const REMOTE_TARGET_HOSTS = ['127.0.0.1', '::1'] as const;
// ssh2 attaches the SSH channel-open failure reason code (RFC 4254) to the
// error surfaced from `forwardOut`. `SSH_OPEN_CONNECT_FAILED` means the remote
// could not connect to the requested destination (e.g. that loopback family is
// not listening), which is the only case worth retrying on the other family.
// Other reasons (administratively prohibited, resource shortage, a dropped
// session) would not be fixed by a retry.
const SSH_OPEN_CONNECT_FAILED = 2;

function isConnectFailure(error: Error): boolean {
  return (error as { reason?: number }).reason === SSH_OPEN_CONNECT_FAILED;
}

export type PortForwardTunnel = {
  localPort: number;
  close(): Promise<void>;
};

export type SshPortForwardProxy = Pick<SshClientProxy, 'client' | 'isConnected'>;
export type K8sPortForwardProxy = Pick<KubeClientProxy, 'kubeConfig' | 'target' | 'isConnected'>;

/**
 * The transport-specific portion of a tunnel request. Both variants share the
 * generic local-listener / EADDRINUSE-fallback machinery in
 * `openPortForwardTunnel`; only `forwardSocket` differs per transport.
 */
export type OpenPortForwardTunnelOptions = {
  remotePort: number;
  preferredLocalPort?: number;
  onConnectionError?: (error: Error) => void;
} & (
  | { transport: 'ssh'; proxy: SshPortForwardProxy }
  | { transport: 'k8s'; proxy: K8sPortForwardProxy }
);

export async function openPortForwardTunnel(
  options: OpenPortForwardTunnelOptions
): Promise<PortForwardTunnel> {
  try {
    return await bindTunnel(options, options.preferredLocalPort ?? 0);
  } catch (error) {
    if (options.preferredLocalPort !== undefined && isAddressInUse(error)) {
      return await bindTunnel(options, 0);
    }
    throw error;
  }
}

function bindTunnel(
  options: OpenPortForwardTunnelOptions,
  localPort: number
): Promise<PortForwardTunnel> {
  const sockets = new Set<net.Socket>();
  // One PortForward per tunnel, reused across the tunnel's sockets (mirroring how
  // the SSH variant reuses the single live ssh2 Client) but constructed lazily on
  // the first connected socket. Building it eagerly would read proxy.kubeConfig at
  // bind time, which throws while the connection is down; deferring keeps binding
  // safe and rebinds to the current live KubeConfig after a reconnect.
  let forward: PortForward | undefined;
  let forwardKubeConfig: KubeConfig | undefined;
  const getForward = (kc: KubeConfig): PortForward => {
    if (!forward || forwardKubeConfig !== kc) {
      forward = new PortForward(kc);
      forwardKubeConfig = kc;
    }
    return forward;
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    forwardSocket(socket, options, getForward);
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('port forward listener did not bind to a TCP address'));
        return;
      }

      resolve({
        localPort: address.port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await closeServer(server);
        },
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOCAL_BIND_HOST, port: localPort });
  });
}

function forwardSocket(
  socket: net.Socket,
  options: OpenPortForwardTunnelOptions,
  getForward: (kc: KubeConfig) => PortForward
): void {
  if (!options.proxy.isConnected) {
    socket.destroy();
    return;
  }

  if (options.transport === 'k8s') {
    forwardK8sSocket(socket, options, getForward);
    return;
  }

  forwardSshSocket(socket, options);
}

function forwardSshSocket(
  socket: net.Socket,
  options: Extract<OpenPortForwardTunnelOptions, { transport: 'ssh' }>
): void {
  let client;
  try {
    client = options.proxy.client;
  } catch {
    socket.destroy();
    return;
  }

  let firstError: Error | undefined;

  const tryTargetHost = (index: number): void => {
    const remoteHost = REMOTE_TARGET_HOSTS[index];
    client.forwardOut(
      LOCAL_BIND_HOST,
      0,
      remoteHost,
      options.remotePort,
      (error: Error | undefined, channel: ClientChannel) => {
        if (error) {
          firstError = firstError ?? error;
          // Only fall back to the next loopback family when the remote could
          // not connect to this one (e.g. an IPv6-only dev server refuses the
          // IPv4 target). Any other failure would not be fixed by a retry, so
          // surface it instead of masking it behind a second dial.
          if (index + 1 < REMOTE_TARGET_HOSTS.length && isConnectFailure(error)) {
            tryTargetHost(index + 1);
            return;
          }
          // Report the first failure so the primary target's cause is preserved
          // when every candidate fails.
          options.onConnectionError?.(firstError);
          socket.destroy();
          return;
        }

        socket.on('error', () => channel.destroy());
        channel.on('error', (channelError: Error) => {
          options.onConnectionError?.(channelError);
          socket.destroy();
        });
        socket.pipe(channel).pipe(socket);
      }
    );
  };

  tryTargetHost(0);
}

function forwardK8sSocket(
  socket: net.Socket,
  options: Extract<OpenPortForwardTunnelOptions, { transport: 'k8s' }>,
  getForward: (kc: KubeConfig) => PortForward
): void {
  let target;
  let forward: PortForward;
  try {
    target = options.proxy.target;
    forward = getForward(options.proxy.kubeConfig);
  } catch {
    socket.destroy();
    return;
  }

  // PortForward.portForward streams the pod's remote port over the API server
  // WebSocket: (namespace, pod, [ports], output, err, input). The socket is the
  // output (pod -> local) and input (local -> pod); the protocol error channel
  // is left null (we surface failures via the rejected promise rather than
  // writing error bytes into the TCP socket). A failure to establish the stream
  // routes through onConnectionError and tears the socket down cleanly, so a
  // dropped/refused remote (or disconnected proxy) never crashes the process.
  void Promise.resolve()
    .then(() =>
      forward.portForward(
        target.namespace,
        target.podName,
        [options.remotePort],
        socket,
        null,
        socket
      )
    )
    .catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      options.onConnectionError?.(err);
      socket.destroy();
    });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EADDRINUSE'
  );
}
