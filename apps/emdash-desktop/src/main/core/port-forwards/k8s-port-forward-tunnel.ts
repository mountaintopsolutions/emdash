import net from 'node:net';
import { PassThrough } from 'node:stream';
import { PortForward } from '@kubernetes/client-node';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';

const LOCAL_BIND_HOST = '127.0.0.1';

export type K8sPortForwardTunnel = {
  localPort: number;
  close(): Promise<void>;
};

export type OpenK8sPortForwardTunnelOptions = {
  proxy: Pick<KubeClientProxy, 'kubeConfig' | 'target' | 'isConnected'>;
  remotePort: number;
  preferredLocalPort?: number;
  onConnectionError?: (error: Error) => void;
};

/**
 * Open a local TCP listener that forwards each incoming connection to a port
 * inside the pod via the Kubernetes PortForward API.
 *
 * Mirrors openPortForwardTunnel (SSH): a local net.Server accepts connections,
 * and for each one, a new PortForward.portForward() WebSocket session is opened
 * to the pod. The k8s port-forward WebSocket multiplexes stdin/stdout/stderr
 * channels (same framing as exec), and the PortForward class pairs the input
 * and output streams with the remote port.
 */
export async function openK8sPortForwardTunnel(
  options: OpenK8sPortForwardTunnelOptions
): Promise<K8sPortForwardTunnel> {
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
  options: OpenK8sPortForwardTunnelOptions,
  localPort: number
): Promise<K8sPortForwardTunnel> {
  const sockets = new Set<net.Socket>();
  const webSockets = new Set<{ close: () => void }>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    forwardSocket(socket, options, webSockets);
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
        reject(new Error('k8s port forward listener did not bind to a TCP address'));
        return;
      }

      resolve({
        localPort: address.port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          for (const ws of webSockets) {
            try {
              ws.close();
            } catch {}
          }
          webSockets.clear();
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
  options: OpenK8sPortForwardTunnelOptions,
  webSockets: Set<{ close: () => void }>
): void {
  if (!options.proxy.isConnected) {
    socket.destroy();
    return;
  }

  let kc: ReturnType<KubeClientProxy['kubeConfig']>;
  let target: KubeClientProxy['target'];
  try {
    kc = options.proxy.kubeConfig;
    target = options.proxy.target;
  } catch {
    socket.destroy();
    return;
  }

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Pipe TCP socket → pod stdin, pod stdout → TCP socket.
  socket.pipe(stdin);
  stdout.pipe(socket);

  socket.on('error', () => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });

  const pf = new PortForward(kc, true);

  pf.portForward(target.namespace, target.podName, [options.remotePort], stdout, stderr, stdin)
    .then((ws) => {
      const socketLike =
        typeof ws === 'function'
          ? { close: () => ws()?.close() }
          : { close: () => ws.close() };
      webSockets.add(socketLike);

      if (typeof ws !== 'function') {
        ws.on('close', () => {
          webSockets.delete(socketLike);
          socket.destroy();
        });
        ws.on('error', (err: Error) => {
          webSockets.delete(socketLike);
          options.onConnectionError?.(err);
          socket.destroy();
        });
      }
    })
    .catch((err: Error) => {
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
