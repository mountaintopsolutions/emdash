import type { KubeConfig } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import type { PreviewServerEvent } from '@shared/core/preview-servers/types';
import { previewServerUrl } from '@shared/core/preview-servers/types';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import { PortForwardService } from '../port-forwards/port-forward-service';
import type {
  K8sPortForwardProxy,
  OpenPortForwardTunnelOptions,
  PortForwardTunnel,
} from '../port-forwards/port-forward-tunnel';
import { PreviewServerService } from './preview-server-service';

function createService(
  options: {
    connectionState?: ConnectionState;
    k8sConnectionState?: ConnectionState;
    openTunnel?: (request: OpenPortForwardTunnelOptions) => Promise<PortForwardTunnel>;
    getSshProxy?: (connectionId: string) => Promise<Pick<SshClientProxy, 'client' | 'isConnected'>>;
    getK8sProxy?: (connectionId: string) => Promise<K8sPortForwardProxy>;
  } = {}
) {
  const events: PreviewServerEvent[] = [];
  const closedTunnelIds: string[] = [];
  const openedTransports: Array<'ssh' | 'k8s'> = [];
  let openedTunnels = 0;
  let connectionState = options.connectionState ?? 'connected';
  let k8sConnectionState = options.k8sConnectionState ?? 'connected';
  const portForwards = new PortForwardService({
    openTunnel:
      options.openTunnel ??
      (async (request) => {
        openedTunnels++;
        openedTransports.push(request.transport);
        return {
          localPort: 6000 + openedTunnels,
          close: async () => {},
        };
      }),
    onTunnelClosed: (id) => closedTunnelIds.push(id),
  });

  const service = new PreviewServerService({
    portForwards,
    emit: (event) => events.push(event),
    getConnectionState: () => connectionState,
    getSshProxy: options.getSshProxy ?? (async () => fakeProxy()),
    getK8sConnectionState: () => k8sConnectionState,
    getK8sProxy: options.getK8sProxy ?? (async () => fakeK8sProxy()),
    closeDelayMs: 250,
  });

  return {
    service,
    events,
    closedTunnelIds,
    openedTransports,
    get openedTunnels() {
      return openedTunnels;
    },
    setConnectionState(next: ConnectionState) {
      connectionState = next;
    },
    setK8sConnectionState(next: ConnectionState) {
      k8sConnectionState = next;
    },
  };
}

function fakeProxy() {
  return {
    isConnected: true,
    get client() {
      return {} as SshClientProxy['client'];
    },
  } satisfies Pick<SshClientProxy, 'client' | 'isConnected'>;
}

function fakeK8sProxy() {
  return {
    isConnected: true,
    get kubeConfig() {
      return {} as KubeConfig;
    },
    get target() {
      return { namespace: 'team-ns', podName: 'dev-pod' };
    },
  } satisfies K8sPortForwardProxy;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PreviewServerService', () => {
  it('registers local detected URLs as workspace-owned direct previews', async () => {
    const { service, events } = createService();

    const first = await service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      transport: 'local',
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      host: 'localhost',
      port: 5173,
      urlPath: '/app',
    });
    const duplicate = await service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      transport: 'local',
      source: { kind: 'terminal-output', terminalId: 'terminal-2' },
      protocol: 'http:',
      host: 'localhost',
      port: 5173,
      urlPath: '/ignored',
    });

    expect(duplicate.id).toBe(first.id);
    expect(
      service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([first]);
    expect(previewServerUrl(first)).toBe('http://localhost:5173/app');
    expect(events).toEqual([{ type: 'upsert', server: first }]);
  });

  it('deduplicates SSH detected URLs by workspace, connection, and remote port', async () => {
    const context = createService();

    const first = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    const duplicate = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/ignored',
    });

    expect(duplicate.id).toBe(first.id);
    expect(context.openedTunnels).toBe(1);
    expect(previewServerUrl(first)).toBe('http://127.0.0.1:6001/');
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([first]);
    expect(
      context.events
        .filter((event) => event.type === 'upsert' && event.server.id === first.id)
        .map((event) => (event.type === 'upsert' ? event.server.status : null))
    ).toEqual([{ kind: 'starting' }, { kind: 'ready' }]);
  });

  it('deduplicates SSH detections while the tunnel is still opening', async () => {
    const tunnel = deferred<PortForwardTunnel>();
    let openCount = 0;
    const context = createService({
      openTunnel: async () => {
        openCount++;
        return await tunnel.promise;
      },
    });

    const firstPromise = context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    const duplicate = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-2' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/ignored',
    });

    expect(duplicate.status).toEqual({ kind: 'starting' });
    expect(openCount).toBe(1);

    tunnel.resolve({ localPort: 6100, close: async () => {} });
    const first = await firstPromise;

    expect(previewServerUrl(first)).toBe('http://127.0.0.1:6100/');
    expect(openCount).toBe(1);
  });

  it('keeps a failed SSH preview row when automatic tunnel opening fails', async () => {
    const context = createService({
      openTunnel: async () => {
        throw new Error('bind failed');
      },
    });

    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    expect(server.kind).toBe('forwarded');
    expect(previewServerUrl(server)).toBeNull();
    expect(server.status).toEqual({
      kind: 'failed',
      message: 'Failed to open SSH port forward',
    });
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([server]);
    expect(
      context.events
        .filter((event) => event.type === 'upsert' && event.server.id === server.id)
        .map((event) => (event.type === 'upsert' ? event.server.status : null))
    ).toEqual([
      { kind: 'starting' },
      { kind: 'failed', message: 'Failed to open SSH port forward' },
    ]);
  });

  it('restarts a failed SSH preview using the remote port as the preferred local port', async () => {
    const preferredLocalPorts: Array<number | undefined> = [];
    let attempt = 0;
    const context = createService({
      openTunnel: async (request) => {
        attempt++;
        preferredLocalPorts.push(request.preferredLocalPort);
        if (attempt === 1) throw new Error('bind failed');
        return { localPort: 6200, close: async () => {} };
      },
    });
    const failed = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    const restarted = await context.service.restart(failed.id);

    expect(preferredLocalPorts).toEqual([5173, 5173]);
    expect(restarted?.status).toEqual({ kind: 'ready' });
    expect(previewServerUrl(restarted!)).toBe('http://127.0.0.1:6200/');
  });

  it('marks a forwarded SSH preview failed when later browser traffic cannot reach the remote port', async () => {
    let onConnectionError: ((error: Error) => void) | undefined;
    const context = createService({
      openTunnel: async (request) => {
        onConnectionError = request.onConnectionError;
        return { localPort: 6100, close: async () => {} };
      },
    });
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    onConnectionError?.(new Error('(SSH) Channel open failure: Connection refused'));
    await new Promise((resolve) => setImmediate(resolve));

    const [failed] = context.service.listForWorkspace({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    expect(failed).toMatchObject({
      id: server.id,
      kind: 'forwarded',
      status: {
        kind: 'failed',
        message: 'Remote preview port is no longer accepting connections',
      },
    });
    expect(previewServerUrl(failed!)).toBeNull();
    expect(context.closedTunnelIds).toEqual([
      'preview:ssh:auto:project-1:workspace-1:connection-1:5173',
    ]);
    expect(context.events.at(-1)).toEqual({ type: 'upsert', server: failed });
  });

  it('keeps SSH terminal previews through transport-loss PTY exits', async () => {
    vi.useFakeTimers();
    try {
      const context = createService({ connectionState: 'reconnecting' });
      const server = await context.service.registerDetectedTarget({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'connection-1',
        transport: 'ssh',
        proxy: fakeProxy(),
        source: { kind: 'terminal-output', terminalId: 'terminal-1' },
        protocol: 'http:',
        port: 5173,
        urlPath: '/',
      });

      await context.service.handleTerminalSourceClosed({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        terminalId: 'terminal-1',
        transport: 'ssh',
        connectionId: 'connection-1',
        reason: 'pty-exit',
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(
        context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
      ).toEqual([server]);
      expect(context.closedTunnelIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops SSH terminal previews after PTY exit when SSH remains connected', async () => {
    vi.useFakeTimers();
    try {
      const context = createService({ connectionState: 'connected' });
      const server = await context.service.registerDetectedTarget({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'connection-1',
        transport: 'ssh',
        proxy: fakeProxy(),
        source: { kind: 'terminal-output', terminalId: 'terminal-1' },
        protocol: 'http:',
        port: 5173,
        urlPath: '/',
      });

      await context.service.handleTerminalSourceClosed({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        terminalId: 'terminal-1',
        transport: 'ssh',
        connectionId: 'connection-1',
        reason: 'pty-exit',
      });
      await context.service.stop(server.id);
      await vi.advanceTimersByTimeAsync(250);

      expect(
        context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
      ).toEqual([]);
      expect(context.events.filter((event) => event.type === 'remove')).toEqual([
        { type: 'remove', id: server.id },
      ]);
      expect(context.closedTunnelIds).toEqual([
        'preview:ssh:auto:project-1:workspace-1:connection-1:5173',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('translates SSH connection events into forwarded preview status updates', async () => {
    const context = createService();
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    context.service.handleSshConnectionEvent({
      type: 'reconnecting',
      connectionId: 'connection-1',
    });
    context.service.handleSshConnectionEvent({ type: 'reconnected', connectionId: 'connection-1' });
    context.service.handleSshConnectionEvent({
      type: 'reconnect-failed',
      connectionId: 'connection-1',
    });

    const statusEvents = context.events
      .filter((event) => event.type === 'upsert' && event.server.id === server.id)
      .map((event) => (event.type === 'upsert' ? event.server.status : null));

    expect(statusEvents).toEqual([
      { kind: 'starting' },
      { kind: 'ready' },
      { kind: 'reconnecting' },
      { kind: 'ready' },
      { kind: 'failed', message: 'SSH connection failed to reconnect' },
    ]);
  });

  it('creates manual forwarded previews with generated identity and root path', async () => {
    const context = createService();

    const firstResult = await context.service.forwardManual({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      protocol: 'https:',
      remotePort: 8443,
      preferredLocalPort: 9443,
    });
    const secondResult = await context.service.forwardManual({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      protocol: 'https:',
      remotePort: 8443,
      preferredLocalPort: 9444,
    });
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    if (!firstResult.success || !secondResult.success) throw new Error('manual forward failed');
    const first = firstResult.data;
    const second = secondResult.data;

    expect(first.id).not.toBe(second.id);
    expect(first.source).toEqual({ kind: 'manual' });
    expect(first.urlPath).toBe('/');
    expect(first.kind).toBe('forwarded');
    expect(previewServerUrl(first)).toBe('https://127.0.0.1:6001/');
    expect(context.openedTunnels).toBe(2);
  });

  it('does not open a manual tunnel when the workspace stops while resolving the SSH proxy', async () => {
    const proxy = deferred<Pick<SshClientProxy, 'client' | 'isConnected'>>();
    let openCount = 0;
    const context = createService({
      getSshProxy: async () => proxy.promise,
      openTunnel: async () => {
        openCount++;
        return { localPort: 6100, close: async () => {} };
      },
    });

    const pending = context.service.forwardManual({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      protocol: 'http:',
      remotePort: 8080,
    });

    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toMatchObject([{ status: { kind: 'starting' } }]);

    await context.service.stopForWorkspace('project-1', 'workspace-1');
    proxy.resolve(fakeProxy());

    await expect(pending).resolves.toEqual({
      success: false,
      error: {
        type: 'cancelled',
        message: 'Manual preview forwarding was cancelled',
      },
    });
    expect(openCount).toBe(0);
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([]);
  });

  it('closes a manual tunnel that resolves after the workspace stops', async () => {
    const openStarted = deferred<void>();
    const tunnel = deferred<PortForwardTunnel>();
    const close = vi.fn(async () => {});
    const context = createService({
      openTunnel: async () => {
        openStarted.resolve();
        return await tunnel.promise;
      },
    });

    const pending = context.service.forwardManual({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      protocol: 'http:',
      remotePort: 8080,
    });

    await openStarted.promise;
    await context.service.stopForWorkspace('project-1', 'workspace-1');

    tunnel.resolve({ localPort: 6100, close });

    await expect(pending).resolves.toEqual({
      success: false,
      error: {
        type: 'cancelled',
        message: 'Manual preview forwarding was cancelled',
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(context.closedTunnelIds).toHaveLength(1);
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([]);
  });

  it('returns an error result and removes the row when manual tunnel opening fails', async () => {
    const context = createService({
      openTunnel: async () => {
        throw new Error('bind failed');
      },
    });

    const result = await context.service.forwardManual({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      protocol: 'http:',
      remotePort: 8080,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'open-failed',
        message: 'Failed to open SSH port forward',
      },
    });
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([]);
    expect(context.events.map((event) => event.type)).toEqual(['upsert', 'remove']);
  });

  it('stops only previews owned by a released workspace', async () => {
    const context = createService();
    const first = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    const second = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-2',
      connectionId: 'connection-1',
      transport: 'ssh',
      proxy: fakeProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-2' },
      protocol: 'http:',
      port: 5174,
      urlPath: '/',
    });

    await context.service.stopForWorkspace('project-1', 'workspace-1');

    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toEqual([]);
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-2' })
    ).toEqual([second]);
    expect(context.events).toContainEqual({ type: 'remove', id: first.id });
    expect(context.closedTunnelIds).toEqual([
      'preview:ssh:auto:project-1:workspace-1:connection-1:5173',
    ]);
  });

  it('registers k8s detected URLs over a k8s port-forward tunnel', async () => {
    const context = createService();

    const first = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    const duplicate = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/ignored',
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.id).toBe('k8s:auto:project-1:workspace-1:kube-1:5173');
    expect(context.openedTunnels).toBe(1);
    expect(context.openedTransports).toEqual(['k8s']);
    expect(previewServerUrl(first)).toBe('http://127.0.0.1:6001/');
  });

  it('keeps a failed k8s preview row with a Kubernetes-specific message', async () => {
    const context = createService({
      openTunnel: async () => {
        throw new Error('bind failed');
      },
    });

    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    expect(server.status).toEqual({
      kind: 'failed',
      message: 'Failed to open Kubernetes port forward',
    });
  });

  it('reconciles a k8s preview to reconnecting when its connection drops, and back when it returns', async () => {
    const context = createService({ k8sConnectionState: 'connected' });
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    expect(server.status).toEqual({ kind: 'ready' });

    // Connection silently drops (no event delivered) — the periodic reconciler
    // should notice and flip the preview to reconnecting.
    context.setK8sConnectionState('disconnected');
    context.service.reconcileForwardedStatuses();
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })[0]
        ?.status
    ).toEqual({ kind: 'reconnecting' });

    // Connection returns — reconcile flips it back to ready.
    context.setK8sConnectionState('connected');
    context.service.reconcileForwardedStatuses();
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })[0]
        ?.status
    ).toEqual({ kind: 'ready' });
  });

  it('leaves a failed k8s preview untouched during reconciliation', async () => {
    const context = createService({
      k8sConnectionState: 'disconnected',
      openTunnel: async () => {
        throw new Error('bind failed');
      },
    });
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
    expect(server.status.kind).toBe('failed');

    context.service.reconcileForwardedStatuses();
    expect(
      context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })[0]
        ?.status.kind
    ).toBe('failed');
  });

  it('stops k8s terminal previews after PTY exit when the connection remains live', async () => {
    vi.useFakeTimers();
    try {
      const context = createService({ k8sConnectionState: 'connected' });
      const server = await context.service.registerDetectedTarget({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'kube-1',
        transport: 'k8s',
        proxy: fakeK8sProxy(),
        source: { kind: 'terminal-output', terminalId: 'terminal-1' },
        protocol: 'http:',
        port: 5173,
        urlPath: '/',
      });

      await context.service.handleTerminalSourceClosed({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        terminalId: 'terminal-1',
        transport: 'k8s',
        connectionId: 'kube-1',
        reason: 'pty-exit',
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(
        context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
      ).toEqual([]);
      expect(context.closedTunnelIds).toEqual([
        'preview:k8s:auto:project-1:workspace-1:kube-1:5173',
      ]);
      expect(server.id).toBe('k8s:auto:project-1:workspace-1:kube-1:5173');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps k8s terminal previews through a transport-loss PTY exit while reconnecting', async () => {
    vi.useFakeTimers();
    try {
      const context = createService({ k8sConnectionState: 'reconnecting' });
      const server = await context.service.registerDetectedTarget({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'kube-1',
        transport: 'k8s',
        proxy: fakeK8sProxy(),
        source: { kind: 'terminal-output', terminalId: 'terminal-1' },
        protocol: 'http:',
        port: 5173,
        urlPath: '/',
      });

      await context.service.handleTerminalSourceClosed({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        terminalId: 'terminal-1',
        transport: 'k8s',
        connectionId: 'kube-1',
        reason: 'pty-exit',
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(
        context.service.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
      ).toEqual([server]);
      expect(context.closedTunnelIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('translates k8s connection events into forwarded preview status updates', async () => {
    const context = createService();
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'kube-1',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    context.service.handleK8sConnectionEvent({ type: 'reconnecting', connectionId: 'kube-1' });
    context.service.handleK8sConnectionEvent({ type: 'reconnected', connectionId: 'kube-1' });
    context.service.handleK8sConnectionEvent({ type: 'reconnect-failed', connectionId: 'kube-1' });

    const statusEvents = context.events
      .filter((event) => event.type === 'upsert' && event.server.id === server.id)
      .map((event) => (event.type === 'upsert' ? event.server.status : null));

    expect(statusEvents).toEqual([
      { kind: 'starting' },
      { kind: 'ready' },
      { kind: 'reconnecting' },
      { kind: 'ready' },
      { kind: 'failed', message: 'Kubernetes connection failed to reconnect' },
    ]);
  });

  it('does not let an SSH connection event affect a k8s preview on the same connection id', async () => {
    const context = createService();
    const server = await context.service.registerDetectedTarget({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      connectionId: 'shared-id',
      transport: 'k8s',
      proxy: fakeK8sProxy(),
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });

    context.service.handleSshConnectionEvent({ type: 'reconnecting', connectionId: 'shared-id' });

    const statusEvents = context.events
      .filter((event) => event.type === 'upsert' && event.server.id === server.id)
      .map((event) => (event.type === 'upsert' ? event.server.status : null));

    // Only the initial starting -> ready from registration; the SSH event is ignored.
    expect(statusEvents).toEqual([{ kind: 'starting' }, { kind: 'ready' }]);
  });
});
