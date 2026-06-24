import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { Transform } from 'node:stream';
import type { KubeConfig } from '@kubernetes/client-node';
import type { ClientChannel } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import type { K8sPortForwardProxy } from './port-forward-tunnel';
import { openPortForwardTunnel } from './port-forward-tunnel';

// Capture every PortForward construction + portForward call so tests can assert
// the tunnel binds one PortForward per tunnel and forwards to the right target.
const portForwardCalls: Array<{
  kc: KubeConfig;
  namespace: string;
  podName: string;
  ports: number[];
}> = [];
const portForwardInstances: Array<{ kc: KubeConfig }> = [];

vi.mock('@kubernetes/client-node', () => {
  class PortForward {
    constructor(private readonly kc: KubeConfig) {
      portForwardInstances.push({ kc });
    }

    async portForward(
      namespace: string,
      podName: string,
      ports: number[],
      output: Writable,
      _err: Writable | null,
      input: Readable
    ): Promise<() => null> {
      portForwardCalls.push({ kc: this.kc, namespace, podName, ports });
      // Echo bytes back with a `remote:` prefix, mirroring the SSH EchoChannel so
      // the round-trip assertions are identical across transports.
      input.on('data', (chunk: Buffer) => {
        output.write(Buffer.from(`remote:${chunk.toString('utf8')}`));
      });
      return () => null;
    }
  }
  return { PortForward };
});

function makeK8sProxy() {
  const kc = { id: 'kube-config' } as unknown as KubeConfig;
  return {
    proxy: {
      get isConnected() {
        return true;
      },
      get kubeConfig() {
        return kc;
      },
      get target() {
        return { namespace: 'team-ns', podName: 'dev-pod' };
      },
    } satisfies K8sPortForwardProxy,
    kc,
  };
}

function makeDisconnectedK8sProxy() {
  return {
    get isConnected() {
      return false;
    },
    get kubeConfig(): KubeConfig {
      throw new Error('Kubernetes connection is not available');
    },
    get target(): KubeClientProxy['target'] {
      throw new Error('Kubernetes connection is not available');
    },
  } satisfies K8sPortForwardProxy;
}

class EchoChannel extends Transform {
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.push(Buffer.from(`remote:${chunk.toString('utf8')}`));
    callback();
  }
}

// ssh2 attaches the RFC 4254 channel-open failure reason code to forwardOut
// errors. 2 is SSH_OPEN_CONNECT_FAILED (the destination could not be reached).
function channelOpenError(message: string, reason: number): Error {
  const error = new Error(message);
  (error as { reason?: number }).reason = reason;
  return error;
}

function makeProxy() {
  const calls: Array<{
    sourceHost: string;
    sourcePort: number;
    remoteHost: string;
    remotePort: number;
  }> = [];

  return {
    calls,
    proxy: {
      get isConnected() {
        return true;
      },
      get client() {
        return {
          forwardOut(
            sourceHost: string,
            sourcePort: number,
            remoteHost: string,
            remotePort: number,
            callback: (error: Error | undefined, channel: ClientChannel) => void
          ) {
            calls.push({ sourceHost, sourcePort, remoteHost, remotePort });
            callback(undefined, new EchoChannel() as unknown as ClientChannel);
          },
        } as SshClientProxy['client'];
      },
    } satisfies Pick<SshClientProxy, 'client' | 'isConnected'>,
  };
}

function makeRejectingProxy(error: Error) {
  return {
    proxy: {
      get isConnected() {
        return true;
      },
      get client() {
        return {
          forwardOut(
            _sourceHost: string,
            _sourcePort: number,
            _remoteHost: string,
            _remotePort: number,
            callback: (error: Error | undefined, channel: ClientChannel) => void
          ) {
            callback(error, undefined as unknown as ClientChannel);
          },
        } as SshClientProxy['client'];
      },
    } satisfies Pick<SshClientProxy, 'client' | 'isConnected'>,
  };
}

function makeFamilyAwareProxy(reachableHost: string) {
  const calls: Array<{ remoteHost: string; remotePort: number }> = [];

  return {
    calls,
    proxy: {
      get isConnected() {
        return true;
      },
      get client() {
        return {
          forwardOut(
            _sourceHost: string,
            _sourcePort: number,
            remoteHost: string,
            remotePort: number,
            callback: (error: Error | undefined, channel: ClientChannel) => void
          ) {
            calls.push({ remoteHost, remotePort });
            if (remoteHost === reachableHost) {
              callback(undefined, new EchoChannel() as unknown as ClientChannel);
              return;
            }
            callback(
              channelOpenError('(SSH) Channel open failure: Connection refused', 2),
              undefined as unknown as ClientChannel
            );
          },
        } as SshClientProxy['client'];
      },
    } satisfies Pick<SshClientProxy, 'client' | 'isConnected'>,
  };
}

function makePerHostFailingProxy(errors: Record<string, Error>) {
  const calls: Array<{ remoteHost: string; remotePort: number }> = [];

  return {
    calls,
    proxy: {
      get isConnected() {
        return true;
      },
      get client() {
        return {
          forwardOut(
            _sourceHost: string,
            _sourcePort: number,
            remoteHost: string,
            remotePort: number,
            callback: (error: Error | undefined, channel: ClientChannel) => void
          ) {
            calls.push({ remoteHost, remotePort });
            callback(
              errors[remoteHost] ?? channelOpenError('(SSH) Channel open failure: unexpected', 2),
              undefined as unknown as ClientChannel
            );
          },
        } as SshClientProxy['client'];
      },
    } satisfies Pick<SshClientProxy, 'client' | 'isConnected'>,
  };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve(address.port);
        return;
      }
      reject(new Error('server did not bind to a TCP port'));
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '';
    socket.setTimeout(1000);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      socket.end();
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('socket timed out'));
    });
  });
}

function connectUntilClosed(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => socket.write('ping'));
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('socket timed out'));
    });
  });
}

describe('openPortForwardTunnel', () => {
  const blockers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(blockers.splice(0).map(closeServer));
  });

  it('binds a local listener and forwards sockets through ssh2 forwardOut', async () => {
    const { proxy, calls } = makeProxy();

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 5173,
    });

    try {
      await expect(roundTrip(tunnel.localPort, 'ping')).resolves.toBe('remote:ping');
      expect(calls).toEqual([
        {
          sourceHost: '127.0.0.1',
          sourcePort: 0,
          remoteHost: '127.0.0.1',
          remotePort: 5173,
        },
      ]);
    } finally {
      await tunnel.close();
    }
  });

  it('falls back to an OS-selected local port when the preferred port is busy', async () => {
    const blocker = net.createServer();
    blockers.push(blocker);
    const busyPort = await listen(blocker);
    const { proxy } = makeProxy();

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 3000,
      preferredLocalPort: busyPort,
    });

    try {
      expect(tunnel.localPort).not.toBe(busyPort);
      await expect(roundTrip(tunnel.localPort, 'ok')).resolves.toBe('remote:ok');
    } finally {
      await tunnel.close();
    }
  });

  it('falls back to the IPv6 loopback when the IPv4 target refuses', async () => {
    const { proxy, calls } = makeFamilyAwareProxy('::1');

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 5173,
    });

    try {
      await expect(roundTrip(tunnel.localPort, 'ping')).resolves.toBe('remote:ping');
      expect(calls).toEqual([
        { remoteHost: '127.0.0.1', remotePort: 5173 },
        { remoteHost: '::1', remotePort: 5173 },
      ]);
    } finally {
      await tunnel.close();
    }
  });

  it('does not fall back to the other family when the remote rejects for a non-connect reason', async () => {
    // Administratively prohibited (reason 1) is not a connect failure, so
    // retrying the other loopback family is pointless and would mask the cause.
    const { proxy, calls } = makePerHostFailingProxy({
      '127.0.0.1': channelOpenError('(SSH) Channel open failure: administratively prohibited', 1),
    });
    const connectionErrors: string[] = [];

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 5173,
      onConnectionError: (error) => connectionErrors.push(error.message),
    });

    try {
      await connectUntilClosed(tunnel.localPort);
      await new Promise((resolve) => setImmediate(resolve));

      expect(calls).toEqual([{ remoteHost: '127.0.0.1', remotePort: 5173 }]);
      expect(connectionErrors).toEqual(['(SSH) Channel open failure: administratively prohibited']);
    } finally {
      await tunnel.close();
    }
  });

  it('surfaces the first error when every loopback family fails to connect', async () => {
    const { proxy, calls } = makePerHostFailingProxy({
      '127.0.0.1': channelOpenError('(SSH) Channel open failure: Connection refused [ipv4]', 2),
      '::1': channelOpenError('(SSH) Channel open failure: Connection refused [ipv6]', 2),
    });
    const connectionErrors: string[] = [];

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 5173,
      onConnectionError: (error) => connectionErrors.push(error.message),
    });

    try {
      await connectUntilClosed(tunnel.localPort);
      await new Promise((resolve) => setImmediate(resolve));

      expect(calls).toEqual([
        { remoteHost: '127.0.0.1', remotePort: 5173 },
        { remoteHost: '::1', remotePort: 5173 },
      ]);
      expect(connectionErrors).toEqual(['(SSH) Channel open failure: Connection refused [ipv4]']);
    } finally {
      await tunnel.close();
    }
  });

  it('closes local sockets without an uncaught exception when the remote port refuses connections', async () => {
    const error = channelOpenError('(SSH) Channel open failure: Connection refused', 2);
    const { proxy } = makeRejectingProxy(error);
    const connectionErrors: string[] = [];
    const uncaughtErrors: string[] = [];
    const onUncaught = (uncaught: Error) => {
      uncaughtErrors.push(uncaught.message);
    };
    process.once('uncaughtException', onUncaught);

    const tunnel = await openPortForwardTunnel({
      transport: 'ssh',
      proxy,
      remotePort: 5173,
      onConnectionError: (error) => connectionErrors.push(error.message),
    });

    try {
      await connectUntilClosed(tunnel.localPort);
      await new Promise((resolve) => setImmediate(resolve));

      expect(connectionErrors).toEqual(['(SSH) Channel open failure: Connection refused']);
      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await tunnel.close();
    }
  });
});

describe('openPortForwardTunnel (k8s)', () => {
  afterEach(() => {
    portForwardCalls.splice(0);
    portForwardInstances.splice(0);
  });

  it('binds a local listener and forwards sockets through the k8s PortForward', async () => {
    const { proxy, kc } = makeK8sProxy();

    const tunnel = await openPortForwardTunnel({
      transport: 'k8s',
      proxy,
      remotePort: 5173,
    });

    try {
      await expect(roundTrip(tunnel.localPort, 'ping')).resolves.toBe('remote:ping');
      // One PortForward is constructed per tunnel (bound to the live KubeConfig)
      // and reused across its sockets.
      expect(portForwardInstances).toEqual([{ kc }]);
      expect(portForwardCalls).toEqual([
        { kc, namespace: 'team-ns', podName: 'dev-pod', ports: [5173] },
      ]);
    } finally {
      await tunnel.close();
    }
  });

  it('destroys the socket without crashing when the proxy is disconnected', async () => {
    const proxy = makeDisconnectedK8sProxy();
    const uncaughtErrors: string[] = [];
    const onUncaught = (uncaught: Error) => uncaughtErrors.push(uncaught.message);
    process.once('uncaughtException', onUncaught);

    const tunnel = await openPortForwardTunnel({
      transport: 'k8s',
      proxy,
      remotePort: 5173,
    });

    try {
      await connectUntilClosed(tunnel.localPort);
      await new Promise((resolve) => setImmediate(resolve));

      // A disconnected proxy never reaches the PortForward; the socket is closed
      // cleanly with no thrown/uncaught error.
      expect(portForwardCalls).toEqual([]);
      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await tunnel.close();
    }
  });
});
