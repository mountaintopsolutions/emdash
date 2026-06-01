import { EventEmitter } from 'node:events';
import { CoreV1Api } from '@kubernetes/client-node';
import type { K8sConnectionRow } from '@main/db/schema';
import type { K8sConnectionEvent } from '@shared/events/k8sEvents';
import type { K8sHealthState } from '@shared/kubernetes';
import type { ConnectionState } from '@shared/ssh';
import type { KubeConnectResult } from '../connect/resolve-kube-connect-config';
import { KubeClientProxy } from './kube-client-proxy';

// ─── Error classes ────────────────────────────────────────────────────────────

export class KubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeAuthError';
  }
}

export class KubeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeTimeoutError';
  }
}

export class KubeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeConnectionError';
  }
}

/**
 * Raised when the target pod does not exist or is not in the Running phase.
 * This is terminal — the manager does NOT auto-retry a gone/not-running pod,
 * because no amount of retrying brings back a pod that was never going to run.
 */
export class KubePodNotRunningError extends Error {
  constructor(
    message: string,
    readonly phase: string | undefined
  ) {
    super(message);
    this.name = 'KubePodNotRunningError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type KubeConnectionManagerEvent =
  | { type: 'connecting'; connectionId: string }
  | { type: 'connected'; connectionId: string; proxy: KubeClientProxy }
  | { type: 'disconnected'; connectionId: string }
  | { type: 'reconnecting'; connectionId: string; attempt: number; delayMs: number }
  | { type: 'reconnected'; connectionId: string; proxy: KubeClientProxy }
  | { type: 'reconnect-failed'; connectionId: string }
  | { type: 'error'; connectionId: string; error: Error };

/** Delays (ms) between successive reconnect attempts. Length = max attempts. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

interface ReconnectState {
  attempt: number;
  timer: NodeJS.Timeout | undefined;
}

type KubeConnectionManagerLog = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export interface KubeConnectionManagerDeps {
  loadConnectionRow?: (id: string) => Promise<K8sConnectionRow | undefined>;
  resolveConnectConfig?: (row: K8sConnectionRow) => Promise<KubeConnectResult>;
  /**
   * Verifies the target pod is Running. Injectable so the manager is unit
   * testable with a fake (no live cluster). Resolves on success and rejects
   * with KubePodNotRunningError when the pod is gone or not Running.
   */
  verifyPodRunning?: (resolved: KubeConnectResult) => Promise<void>;
  publishEvent?: (event: K8sConnectionEvent) => void;
  log?: KubeConnectionManagerLog;
}

const noopLog: KubeConnectionManagerLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Default pod-phase verification using the CoreV1Api. Reads the target pod and
 * rejects with KubePodNotRunningError unless the phase is 'Running'.
 */
export async function verifyPodRunning(resolved: KubeConnectResult): Promise<void> {
  const core = resolved.kc.makeApiClient(CoreV1Api);
  let pod: { status?: { phase?: string } };
  try {
    pod = await core.readNamespacedPod({
      name: resolved.target.podName,
      namespace: resolved.target.namespace,
    });
  } catch (error) {
    if (isNotFound(error)) {
      throw new KubePodNotRunningError(
        `Pod '${resolved.target.podName}' not found in namespace '${resolved.target.namespace}'`,
        undefined
      );
    }
    throw error;
  }
  const phase = pod.status?.phase;
  if (phase !== 'Running') {
    throw new KubePodNotRunningError(
      `Pod '${resolved.target.podName}' is not running (phase: ${phase ?? 'Unknown'})`,
      phase
    );
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    statusCode?: number;
    code?: number;
    response?: { statusCode?: number };
  };
  return (
    candidate?.statusCode === 404 ||
    candidate?.code === 404 ||
    candidate?.response?.statusCode === 404
  );
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class KubeConnectionManager extends EventEmitter {
  private readonly deps: Required<
    Pick<KubeConnectionManagerDeps, 'verifyPodRunning' | 'publishEvent' | 'log'>
  > &
    Pick<KubeConnectionManagerDeps, 'loadConnectionRow' | 'resolveConnectConfig'>;

  constructor(deps: KubeConnectionManagerDeps = {}) {
    super();
    this.deps = {
      loadConnectionRow: deps.loadConnectionRow,
      resolveConnectConfig: deps.resolveConnectConfig,
      verifyPodRunning: deps.verifyPodRunning ?? verifyPodRunning,
      publishEvent: deps.publishEvent ?? (() => {}),
      log: deps.log ?? noopLog,
    };
  }

  /** One stable proxy per connection ID — survives reconnects. */
  private proxies: Map<string, KubeClientProxy> = new Map();

  private pendingConnections: Map<string, Promise<KubeClientProxy>> = new Map();

  /** Tracks ongoing reconnect backoff state per connection. */
  private reconnecting: Map<string, ReconnectState> = new Map();

  private connectionCleanups: Map<string, () => void> = new Map();

  private connectionGenerations: Map<string, number> = new Map();

  private healthStates: Map<string, K8sHealthState> = new Map();

  /**
   * IDs for which disconnect() was called — these are excluded from
   * auto-reconnect so an intentional teardown is never silently restarted.
   */
  private intentionalDisconnects: Set<string> = new Set();

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Connect and register a proxy under the given ID.
   *
   * - Reuses an existing connection if already in the pool.
   * - Concurrent calls for the same ID coalesce to a single attempt.
   * - Throws KubeAuthError, KubeTimeoutError, KubePodNotRunningError, or
   *   KubeConnectionError on failure.
   */
  async connect(id: string): Promise<KubeClientProxy> {
    this.intentionalDisconnects.delete(id);

    const existing = this.proxies.get(id);
    if (existing?.isConnected) return existing;

    const pending = this.pendingConnections.get(id);
    if (pending) return await pending;

    const generation = this.nextConnectionGeneration(id);
    this.emitConnecting(id);
    const connectionPromise = this.connectPersisted(id, generation);
    this.pendingConnections.set(id, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      if (this.pendingConnections.get(id) === connectionPromise) {
        this.pendingConnections.delete(id);
      }
    }
  }

  private async connectPersisted(id: string, generation: number): Promise<KubeClientProxy> {
    if (!this.deps.loadConnectionRow || !this.deps.resolveConnectConfig) {
      throw new KubeConnectionError(
        'Kubernetes connection manager is missing production dependencies'
      );
    }

    const row = await this.deps.loadConnectionRow(id);
    if (
      !this.isCurrentConnectionGeneration(id, generation) ||
      this.intentionalDisconnects.has(id)
    ) {
      throw new KubeConnectionError(
        `Kubernetes connection '${id}' was disconnected before connecting`
      );
    }

    if (!row) {
      throw new KubeConnectionError(`Kubernetes connection '${id}' not found`);
    }

    let resolved: KubeConnectResult;
    try {
      resolved = await this.deps.resolveConnectConfig(row);
    } catch (error) {
      throw classifyError(error);
    }

    if (
      !this.isCurrentConnectionGeneration(id, generation) ||
      this.intentionalDisconnects.has(id)
    ) {
      resolved.cleanup();
      throw new KubeConnectionError(
        `Kubernetes connection '${id}' was disconnected before connecting`
      );
    }

    return await this.createConnection(id, resolved, { emitConnecting: false, generation });
  }

  /**
   * Force an immediate reconnect, resetting any in-flight backoff countdown.
   *
   * Used by the manual "Reconnect" affordance: clears the existing reconnect
   * state, invalidates the held transport so `connect()` cannot early-return on
   * a stale `isConnected`, and re-runs the full connect path (re-verifying the
   * pod). Throws the same errors as `connect()`.
   */
  async reconnect(id: string): Promise<KubeClientProxy> {
    this.cancelReconnect(id);
    return this.invalidateThenConnect(id);
  }

  /**
   * Drop the held transport then re-run the connect path. Invalidating first is
   * required because a dropped exec leaves `isConnected` true, which would make
   * `connect()` early-return without re-verifying the pod.
   */
  private invalidateThenConnect(id: string): Promise<KubeClientProxy> {
    this.proxies.get(id)?.invalidate();
    return this.connect(id);
  }

  /** Get the stable KubeClientProxy for a connection, or undefined. */
  getProxy(id: string): KubeClientProxy | undefined {
    return this.proxies.get(id);
  }

  /** Returns true if the connection is currently live. */
  isConnected(id: string): boolean {
    return this.proxies.get(id)?.isConnected ?? false;
  }

  /** IDs of all connections that have a proxy (connected or reconnecting). */
  getConnectionIds(): string[] {
    return Array.from(this.proxies.keys());
  }

  /** Returns the current ConnectionState for a single connection ID. */
  getConnectionState(id: string): ConnectionState {
    if (this.proxies.get(id)?.isConnected) return 'connected';
    if (this.reconnecting.has(id)) return 'reconnecting';
    if (this.pendingConnections.has(id)) return 'connecting';
    return 'disconnected';
  }

  /** Returns the current ConnectionState for every tracked connection. */
  getAllConnectionStates(): Record<string, ConnectionState> {
    const result: Record<string, ConnectionState> = {};
    for (const id of this.proxies.keys()) {
      result[id] = this.getConnectionState(id);
    }
    for (const id of this.pendingConnections.keys()) {
      result[id] = this.getConnectionState(id);
    }
    return result;
  }

  getAllHealthStates(): Record<string, K8sHealthState> {
    return Object.fromEntries(this.healthStates);
  }

  reportChannelError(connectionId: string, _error: unknown): void {
    this.healthStates.set(connectionId, { status: 'degraded' });
    this.emitHealthChanged(connectionId, { status: 'degraded' });

    // A dropped exec WebSocket does not invalidate the held transport, so
    // `isConnected` stays true and nothing would re-verify the pod. Auto-start a
    // reconnect loop (which invalidates-then-connects, forcing verifyPodRunning)
    // so a healthy pod recovers on its own and a truly gone pod terminates the
    // loop via KubePodNotRunningError. Skip intentional teardown and don't stack
    // duplicate loops.
    if (this.intentionalDisconnects.has(connectionId)) return;
    if (this.reconnecting.has(connectionId)) return;
    this.scheduleReconnect(connectionId);
  }

  reportChannelRecovered(connectionId: string): void {
    this.clearHealthState(connectionId);
  }

  /**
   * Gracefully close a connection and permanently stop reconnection for it.
   * This is an intentional teardown — auto-reconnect will NOT fire afterward.
   */
  async disconnect(id: string): Promise<void> {
    this.intentionalDisconnects.add(id);
    this.nextConnectionGeneration(id);
    this.cancelReconnect(id);

    const proxy = this.proxies.get(id);
    if (proxy) {
      proxy.invalidate();
    }
    this.runConnectionCleanup(id);
    this.proxies.delete(id);
    this.pendingConnections.delete(id);
    this.clearHealthState(id);

    this.emit('connection-event', {
      type: 'disconnected',
      connectionId: id,
    } satisfies KubeConnectionManagerEvent);
    this.deps.publishEvent({ type: 'disconnected', connectionId: id });
  }

  /** Gracefully close all connections. */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(new Set([...this.proxies.keys(), ...this.pendingConnections.keys()]));
    this.deps.log.info('KubeConnectionManager: disconnecting all connections', {
      count: ids.length,
    });
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  /**
   * Establish an ephemeral connection from a caller-supplied resolved config.
   * Marked intentional from the start so it never schedules a reconnect —
   * callers tear down via `disconnect(id)`.
   */
  async connectFromConfig(id: string, resolved: KubeConnectResult): Promise<KubeClientProxy> {
    this.intentionalDisconnects.add(id);
    const generation = this.nextConnectionGeneration(id);
    const connectionPromise = this.createConnection(id, resolved, { generation });
    this.pendingConnections.set(id, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      this.pendingConnections.delete(id);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async createConnection(
    id: string,
    resolved: KubeConnectResult,
    options: { emitConnecting?: boolean; generation?: number } = {}
  ): Promise<KubeClientProxy> {
    this.deps.log.info('KubeConnectionManager: creating connection', {
      connectionId: id,
      context: resolved.context,
      namespace: resolved.target.namespace,
      podName: resolved.target.podName,
    });

    if (options.emitConnecting !== false) {
      this.emitConnecting(id);
    }

    // Ensure a stable proxy exists for this ID.
    const proxy = this.proxies.get(id) ?? new KubeClientProxy(id, this);
    this.proxies.set(id, proxy);

    let cleanupCalled = false;
    const cleanupOnce = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      this.connectionCleanups.delete(id);
      resolved.cleanup();
    };
    this.connectionCleanups.set(id, cleanupOnce);

    try {
      // Verify the pod is Running before declaring the connection live. A gone
      // or not-running pod throws KubePodNotRunningError (terminal).
      await this.deps.verifyPodRunning(resolved);
    } catch (error) {
      cleanupOnce();
      const classified = classifyError(error);
      this.emitError(id, classified);
      throw classified;
    }

    if (
      options.generation !== undefined &&
      (!this.isCurrentConnectionGeneration(id, options.generation) ||
        this.intentionalDisconnects.has(id))
    ) {
      cleanupOnce();
      throw new KubeConnectionError(`Kubernetes connection '${id}' was disconnected before ready`);
    }

    proxy.update(resolved.kc, resolved.target);
    this.clearHealthState(id);

    // Capture the in-pod login-shell profile once, non-blocking.
    proxy.getRemoteShellProfile().catch((err: unknown) => {
      this.deps.log.warn('KubeConnectionManager: remote shell profile capture failed', {
        connectionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const isReconnect = this.reconnecting.has(id);
    this.cancelReconnect(id);

    this.emit('connection-event', {
      type: isReconnect ? 'reconnected' : 'connected',
      connectionId: id,
      proxy,
    } satisfies KubeConnectionManagerEvent);

    this.deps.publishEvent({
      type: isReconnect ? 'reconnected' : 'connected',
      connectionId: id,
    });

    return proxy;
  }

  private emitError(id: string, error: Error): void {
    this.deps.log.error('KubeConnectionManager: connection error', {
      connectionId: id,
      error: error.message,
    });
    this.emit('connection-event', {
      type: 'error',
      connectionId: id,
      error,
    } satisfies KubeConnectionManagerEvent);
    this.deps.publishEvent({
      type: 'error',
      connectionId: id,
      errorMessage: error.message,
    });
  }

  private scheduleReconnect(id: string): void {
    const state = this.reconnecting.get(id) ?? { attempt: 0, timer: undefined };
    const attempt = state.attempt + 1;

    if (attempt > RECONNECT_DELAYS_MS.length) {
      this.deps.log.error('KubeConnectionManager: max reconnect attempts reached', {
        connectionId: id,
      });
      this.reconnecting.delete(id);
      this.emit('connection-event', {
        type: 'reconnect-failed',
        connectionId: id,
      } satisfies KubeConnectionManagerEvent);
      this.deps.publishEvent({ type: 'reconnect-failed', connectionId: id });
      return;
    }

    const delayMs = RECONNECT_DELAYS_MS[attempt - 1]!;

    this.deps.log.info('KubeConnectionManager: scheduling reconnect', {
      connectionId: id,
      attempt,
      delayMs,
    });

    this.emit('connection-event', {
      type: 'reconnecting',
      connectionId: id,
      attempt,
      delayMs,
    } satisfies KubeConnectionManagerEvent);

    this.deps.publishEvent({ type: 'reconnecting', connectionId: id, attempt, delayMs });

    const timer = setTimeout(() => {
      if (this.intentionalDisconnects.has(id)) {
        this.reconnecting.delete(id);
        return;
      }

      // Invalidate first so connect() re-verifies the pod instead of
      // early-returning on a stale `isConnected` transport.
      const connectionPromise = this.invalidateThenConnect(id);
      this.pendingConnections.set(id, connectionPromise);

      connectionPromise
        .then(() => {
          this.pendingConnections.delete(id);
        })
        .catch((error: unknown) => {
          this.pendingConnections.delete(id);
          // Auth failures and a gone/not-running pod won't recover with
          // retries — stop immediately.
          if (error instanceof KubeAuthError || error instanceof KubePodNotRunningError) {
            this.deps.log.error('KubeConnectionManager: reconnect stopped — terminal failure', {
              connectionId: id,
              error: error.message,
            });
            this.reconnecting.delete(id);
            this.emit('connection-event', {
              type: 'reconnect-failed',
              connectionId: id,
            } satisfies KubeConnectionManagerEvent);
            this.deps.publishEvent({ type: 'reconnect-failed', connectionId: id });
          } else if (this.intentionalDisconnects.has(id)) {
            this.reconnecting.delete(id);
          } else {
            this.scheduleReconnect(id);
          }
        });
    }, delayMs);

    this.reconnecting.set(id, { attempt, timer });
  }

  /**
   * Trigger a reconnect cycle for a connection whose transport failed at use
   * time (e.g. a transient API blip during an exec). Skips terminal/intentional
   * states. Exposed for the proxy/health layer to escalate recoverable drops.
   */
  notifyTransportDropped(id: string): void {
    if (this.intentionalDisconnects.has(id)) return;
    if (this.reconnecting.has(id)) return;
    const proxy = this.proxies.get(id);
    if (proxy?.isConnected) proxy.invalidate();
    this.scheduleReconnect(id);
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnecting.get(id);
    if (state?.timer !== undefined) {
      clearTimeout(state.timer);
    }
    this.reconnecting.delete(id);
  }

  private runConnectionCleanup(id: string): void {
    this.connectionCleanups.get(id)?.();
  }

  private emitConnecting(id: string): void {
    this.emit('connection-event', {
      type: 'connecting',
      connectionId: id,
    } satisfies KubeConnectionManagerEvent);

    this.deps.publishEvent({ type: 'connecting', connectionId: id });
  }

  private nextConnectionGeneration(id: string): number {
    const next = (this.connectionGenerations.get(id) ?? 0) + 1;
    this.connectionGenerations.set(id, next);
    return next;
  }

  private isCurrentConnectionGeneration(id: string, generation: number): boolean {
    return this.connectionGenerations.get(id) === generation;
  }

  private clearHealthState(connectionId: string): K8sHealthState {
    const health: K8sHealthState = { status: 'ok' };
    if (this.healthStates.delete(connectionId)) {
      this.emitHealthChanged(connectionId, health);
    }
    return health;
  }

  private emitHealthChanged(connectionId: string, health: K8sHealthState): void {
    this.deps.publishEvent({ type: 'health-changed', connectionId, health });
  }
}

function classifyError(
  error: unknown
): KubeAuthError | KubeTimeoutError | KubePodNotRunningError | KubeConnectionError {
  if (error instanceof KubePodNotRunningError) return error;
  if (error instanceof KubeAuthError) return error;
  if (error instanceof KubeTimeoutError) return error;
  if (error instanceof KubeConnectionError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication') ||
    lower.includes('credentials')
  ) {
    return new KubeAuthError(message);
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new KubeTimeoutError(message);
  }
  return new KubeConnectionError(message);
}
