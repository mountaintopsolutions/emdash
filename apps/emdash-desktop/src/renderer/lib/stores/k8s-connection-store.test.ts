import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { K8sConnectionEvent } from '@shared/events/k8sEvents';
import { K8sConnectionStore } from './k8s-connection-store';

const k8sEventHandlers: Array<(event: K8sConnectionEvent) => void> = [];

function emitK8sEvent(event: K8sConnectionEvent): void {
  for (const handler of k8sEventHandlers) handler(event);
}

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn((_channel, handler: (event: K8sConnectionEvent) => void) => {
      k8sEventHandlers.push(handler);
      return () => {};
    }),
  },
  rpc: {
    k8s: {
      connect: vi.fn(async () => {}),
      deleteConnection: vi.fn(async () => {}),
      getConnections: vi.fn(async () => []),
      getConnectionState: vi.fn(async () => ({})),
      getHealthStates: vi.fn(async () => ({})),
      listContexts: vi.fn(async () => []),
      listNamespaces: vi.fn(async () => []),
      listPods: vi.fn(async () => []),
      renameConnection: vi.fn(async () => {}),
      saveConnection: vi.fn(async (config) => ({ ...config, id: 'k8s-1' })),
      testConnection: vi.fn(async () => ({ success: true })),
    },
  },
}));

const { rpc } = await import('@renderer/lib/ipc');

describe('K8sConnectionStore', () => {
  beforeEach(() => {
    k8sEventHandlers.length = 0;
  });

  it('notifies when a Kubernetes connection becomes ready', () => {
    const onConnectionReady = vi.fn();
    const store = new K8sConnectionStore({ onConnectionReady });
    store.start();

    emitK8sEvent({ type: 'connected', connectionId: 'k8s-1' });
    emitK8sEvent({ type: 'reconnected', connectionId: 'k8s-1' });
    emitK8sEvent({ type: 'disconnected', connectionId: 'k8s-1' });

    expect(onConnectionReady).toHaveBeenCalledTimes(2);
    expect(onConnectionReady).toHaveBeenNthCalledWith(1, 'k8s-1');
    expect(onConnectionReady).toHaveBeenNthCalledWith(2, 'k8s-1');
  });

  it('notifies for initially connected Kubernetes connections', async () => {
    vi.mocked(rpc.k8s.getConnectionState).mockResolvedValueOnce({
      'k8s-1': 'connected',
      'k8s-2': 'disconnected',
    });
    const onConnectionReady = vi.fn();
    const store = new K8sConnectionStore({ onConnectionReady });

    store.start();
    await store.connectionStatesResource.load();

    expect(onConnectionReady).toHaveBeenCalledWith('k8s-1');
    expect(onConnectionReady).not.toHaveBeenCalledWith('k8s-2');
  });

  it('tracks Kubernetes health changes separately from connection state', () => {
    const store = new K8sConnectionStore();
    store.start();

    emitK8sEvent({
      type: 'health-changed',
      connectionId: 'k8s-1',
      health: {
        status: 'degraded',
      },
    });

    expect(store.healthFor('k8s-1')).toEqual({
      status: 'degraded',
    });
    expect(store.stateFor('k8s-1')).toBe('disconnected');

    emitK8sEvent({
      type: 'health-changed',
      connectionId: 'k8s-1',
      health: { status: 'ok' },
    });

    expect(store.healthFor('k8s-1')).toEqual({ status: 'ok' });
    expect(store.healthStates).toEqual({});
  });

  it('persists pod target metadata through saveConnection', async () => {
    const store = new K8sConnectionStore();

    await store.saveConnection({
      name: 'Cluster',
      context: 'kind-dev',
      namespace: 'default',
      podName: 'app-0',
      containerName: 'app',
    });

    expect(rpc.k8s.saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'kind-dev',
        namespace: 'default',
        podName: 'app-0',
        containerName: 'app',
      })
    );
  });

  it('exposes cascading discovery helpers', async () => {
    const store = new K8sConnectionStore();

    await store.getContexts();
    await store.getNamespaces('kind-dev');
    await store.getPods('kind-dev', 'default');

    expect(rpc.k8s.listContexts).toHaveBeenCalledWith(undefined);
    expect(rpc.k8s.listNamespaces).toHaveBeenCalledWith({
      context: 'kind-dev',
      kubeconfigPath: undefined,
    });
    expect(rpc.k8s.listPods).toHaveBeenCalledWith({
      context: 'kind-dev',
      namespace: 'default',
      kubeconfigPath: undefined,
    });
  });
});
