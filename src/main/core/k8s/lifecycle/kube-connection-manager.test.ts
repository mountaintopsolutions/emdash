import { afterEach, describe, expect, it, vi } from 'vitest';
import type { K8sConnectionRow } from '@main/db/schema';
import type { KubeConnectResult } from '../connect/resolve-kube-connect-config';
import {
  KubeAuthError,
  KubeConnectionManager,
  KubePodNotRunningError,
} from './kube-connection-manager';

function makeRow(id = 'k8s-1'): K8sConnectionRow {
  return {
    id,
    name: 'Stored',
    context: 'kind-dev',
    namespace: 'default',
    podName: 'workspace-pod',
    containerName: null,
    kubeconfigPath: null,
    metadata: null,
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
  };
}

function makeResolved(_id = 'k8s-1'): KubeConnectResult {
  return {
    // A minimal stand-in for KubeConfig; the manager never touches it directly
    // when verifyPodRunning is injected, and KubeClientProxy.update only wraps
    // it in an Exec instance.
    kc: {} as KubeConnectResult['kc'],
    target: { namespace: 'default', podName: 'workspace-pod', containerName: undefined },
    context: 'kind-dev',
    cleanup: vi.fn(),
    debugLogs: [],
  };
}

function isHealthChanged(event: unknown): boolean {
  return (event as { type?: string }).type === 'health-changed';
}

describe('KubeConnectionManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects after verifying the pod is running', async () => {
    const verifyPodRunning = vi.fn().mockResolvedValue(undefined);
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning,
    });

    const proxy = await manager.connect('k8s-1');

    expect(verifyPodRunning).toHaveBeenCalledTimes(1);
    expect(proxy.isConnected).toBe(true);
    expect(manager.getConnectionState('k8s-1')).toBe('connected');
  });

  it('coalesces concurrent connects into a single resolve + verify', async () => {
    const resolveConnectConfig = vi.fn(async () => makeResolved());
    const verifyPodRunning = vi.fn().mockResolvedValue(undefined);
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig,
      verifyPodRunning,
    });

    const [first, second] = await Promise.all([manager.connect('k8s-1'), manager.connect('k8s-1')]);

    expect(first).toBe(second);
    expect(resolveConnectConfig).toHaveBeenCalledTimes(1);
    expect(verifyPodRunning).toHaveBeenCalledTimes(1);
  });

  it('does not retry a pod that is not running and emits an error', async () => {
    const published: Array<{ type: string }> = [];
    const cleanup = vi.fn();
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => ({ ...makeResolved(), cleanup }),
      verifyPodRunning: async () => {
        throw new KubePodNotRunningError('pod gone', undefined);
      },
      publishEvent: (event) => published.push(event),
    });

    await expect(manager.connect('k8s-1')).rejects.toBeInstanceOf(KubePodNotRunningError);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manager.getConnectionState('k8s-1')).toBe('disconnected');
    expect(published.map((event) => event.type)).toContain('error');
  });

  it('classifies unauthorized resolver failures as auth errors', async () => {
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => {
        throw new Error('Unauthorized: token expired');
      },
      verifyPodRunning: async () => {},
    });

    await expect(manager.connect('k8s-1')).rejects.toBeInstanceOf(KubeAuthError);
  });

  it('disconnect tears down the proxy and stops reconnects', async () => {
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning: async () => {},
    });

    const proxy = await manager.connect('k8s-1');
    expect(proxy.isConnected).toBe(true);

    await manager.disconnect('k8s-1');

    expect(proxy.isConnected).toBe(false);
    expect(manager.getConnectionState('k8s-1')).toBe('disconnected');
    expect(manager.getProxy('k8s-1')).toBeUndefined();
  });

  it('reports and clears degraded health for channel errors', async () => {
    vi.useFakeTimers();
    const published: unknown[] = [];
    const manager = new KubeConnectionManager({
      publishEvent: (event) => published.push(event),
    });

    manager.reportChannelError('k8s-1', new Error('exec channel failed'));
    expect(manager.getAllHealthStates()).toEqual({ 'k8s-1': { status: 'degraded' } });

    manager.reportChannelRecovered('k8s-1');
    expect(manager.getAllHealthStates()).toEqual({});
    // reportChannelError also kicks off an auto-reconnect attempt; this test
    // only asserts the health-changed transitions.
    expect(published.filter((event) => isHealthChanged(event))).toEqual([
      { type: 'health-changed', connectionId: 'k8s-1', health: { status: 'degraded' } },
      { type: 'health-changed', connectionId: 'k8s-1', health: { status: 'ok' } },
    ]);
  });

  it('rejects persisted connects when production dependencies or rows are missing', async () => {
    await expect(new KubeConnectionManager().connect('missing-deps')).rejects.toThrow(
      'missing production dependencies'
    );

    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => undefined,
      resolveConnectConfig: async () => {
        throw new Error('should not resolve');
      },
      verifyPodRunning: async () => {},
    });

    await expect(manager.connect('missing-row')).rejects.toThrow('not found');
  });

  it('auto-schedules a reconnect when a channel error degrades a live connection', async () => {
    vi.useFakeTimers();
    const published: Array<{ type: string }> = [];
    const verifyPodRunning = vi.fn().mockResolvedValue(undefined);
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning,
      publishEvent: (event) => published.push(event),
    });

    const proxy = await manager.connect('k8s-1');
    expect(proxy.isConnected).toBe(true);
    verifyPodRunning.mockClear();

    // A dropped exec keeps the transport held (isConnected stays true) but the
    // connection is degraded — the manager should start recovering on its own.
    manager.reportChannelError('k8s-1', new Error('exec channel dropped'));
    expect(manager.getAllHealthStates()).toEqual({ 'k8s-1': { status: 'degraded' } });
    // A reconnect is scheduled even though the stale transport is still held.
    expect(published.map((event) => event.type)).toContain('reconnecting');

    // The backoff timer invalidates the stale transport and re-verifies the pod
    // (a bare connect() would early-return on isConnected without re-verifying).
    await vi.runOnlyPendingTimersAsync();
    expect(verifyPodRunning).toHaveBeenCalled();
    expect(published.map((event) => event.type)).toContain('reconnected');
  });

  it('does not stack a second reconnect loop while one is already running', async () => {
    vi.useFakeTimers();
    const published: Array<{ type: string }> = [];
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning: async () => {},
      publishEvent: (event) => published.push(event),
    });

    // No prior connect(): keeps the (fake-kc) shell-profile capture out of the
    // picture so only the manual channel errors drive scheduling. The first one
    // starts a loop; the second must be swallowed by the "already reconnecting"
    // guard rather than stacking a duplicate timer.
    manager.reportChannelError('k8s-1', new Error('drop 1'));
    manager.reportChannelError('k8s-1', new Error('drop 2'));

    const reconnecting = published.filter((event) => event.type === 'reconnecting');
    expect(reconnecting).toHaveLength(1);

    // Cancel the scheduled backoff timer so it never fires past the test.
    await manager.disconnect('k8s-1');
  });

  it('reconnect() invalidates the held transport and re-verifies the pod', async () => {
    const verifyPodRunning = vi.fn().mockResolvedValue(undefined);
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning,
    });

    const proxy = await manager.connect('k8s-1');
    expect(proxy.isConnected).toBe(true);
    verifyPodRunning.mockClear();

    // connect() would early-return on the still-held transport; reconnect() must
    // invalidate first so verifyPodRunning runs again.
    const reconnected = await manager.reconnect('k8s-1');
    expect(verifyPodRunning).toHaveBeenCalledTimes(1);
    expect(reconnected).toBe(proxy);
    expect(manager.getConnectionState('k8s-1')).toBe('connected');
  });

  it('stops the auto-reconnect loop when the pod is gone', async () => {
    vi.useFakeTimers();
    const published: Array<{ type: string }> = [];
    const manager = new KubeConnectionManager({
      loadConnectionRow: async () => makeRow(),
      resolveConnectConfig: async () => makeResolved(),
      verifyPodRunning: async () => {
        throw new KubePodNotRunningError('pod gone', undefined);
      },
      publishEvent: (event) => published.push(event),
    });

    manager.reportChannelError('k8s-1', new Error('exec channel dropped'));
    expect(published.map((event) => event.type)).toContain('reconnecting');

    await vi.runOnlyPendingTimersAsync();

    // A gone pod is terminal: the loop ends with reconnect-failed, not endless retries.
    expect(published.map((event) => event.type)).toContain('reconnect-failed');
    expect(manager.getConnectionState('k8s-1')).toBe('disconnected');
  });
});
