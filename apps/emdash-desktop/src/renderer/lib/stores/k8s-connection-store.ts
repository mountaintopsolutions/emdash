import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import { k8sConnectionEventChannel, type K8sConnectionEvent } from '@shared/events/k8sEvents';
import type {
  ConnectionTestResult,
  K8sConfig,
  K8sConfigContext,
  K8sHealthState,
} from '@shared/kubernetes';
import { Resource } from './resource';

type SaveConnectionInput = Partial<Pick<K8sConfig, 'id'>> &
  Omit<K8sConfig, 'id'> & { token?: string };

type K8sConnectionStoreOptions = {
  onConnectionReady?: (connectionId: string) => void;
};

type K8sConnectionStateEvent = Exclude<K8sConnectionEvent, { type: 'health-changed' }>;

/** Live auto-reconnect countdown for a single connection. */
export type K8sReconnectInfo = {
  attempt: number;
  delayMs: number;
  /** Epoch ms when the reconnect was scheduled; countdown = scheduledAt + delayMs - now. */
  scheduledAt: number;
};

function toConnectionState(event: K8sConnectionStateEvent): ConnectionState {
  switch (event.type) {
    case 'connected':
    case 'reconnected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'disconnected':
    case 'reconnect-failed':
      return 'disconnected';
    case 'error':
      return 'error';
  }
}

export class K8sConnectionStore {
  readonly connectionsResource: Resource<K8sConfig[]>;
  readonly connectionStatesResource: Resource<Record<string, ConnectionState>, K8sConnectionEvent>;
  readonly healthStatesResource: Resource<Record<string, K8sHealthState>, K8sConnectionEvent>;
  readonly reconnectInfoResource: Resource<Record<string, K8sReconnectInfo>, K8sConnectionEvent>;

  private pendingMutations = 0;
  private started = false;
  private readonly onConnectionReady?: (connectionId: string) => void;

  constructor({ onConnectionReady }: K8sConnectionStoreOptions = {}) {
    this.onConnectionReady = onConnectionReady;
    this.connectionsResource = new Resource<K8sConfig[]>(() => rpc.k8s.getConnections(), []);

    this.connectionStatesResource = new Resource<
      Record<string, ConnectionState>,
      K8sConnectionEvent
    >(async () => {
      const states = await rpc.k8s.getConnectionState();
      for (const [connectionId, state] of Object.entries(states)) {
        if (state === 'connected') this.onConnectionReady?.(connectionId);
      }
      return states;
    }, [
      {
        kind: 'event',
        subscribe: (handler) => events.on(k8sConnectionEventChannel, handler),
        onEvent: (event, ctx) => {
          if (event.type === 'health-changed') return;
          const next = { ...(ctx.data ?? {}) };
          next[event.connectionId] = toConnectionState(event);
          ctx.set(next);
          if (event.type === 'connected' || event.type === 'reconnected') {
            this.onConnectionReady?.(event.connectionId);
          }
        },
      },
    ]);

    this.healthStatesResource = new Resource<Record<string, K8sHealthState>, K8sConnectionEvent>(
      () => rpc.k8s.getHealthStates(),
      [
        {
          kind: 'event',
          subscribe: (handler) => events.on(k8sConnectionEventChannel, handler),
          onEvent: (event, ctx) => {
            if (event.type !== 'health-changed') return;
            const next = { ...(ctx.data ?? {}) };
            if (event.health.status === 'ok') {
              delete next[event.connectionId];
            } else {
              next[event.connectionId] = event.health;
            }
            ctx.set(next);
          },
        },
      ]
    );

    this.reconnectInfoResource = new Resource<Record<string, K8sReconnectInfo>, K8sConnectionEvent>(
      null,
      [
        {
          kind: 'event',
          subscribe: (handler) => events.on(k8sConnectionEventChannel, handler),
          onEvent: (event, ctx) => {
            const next = { ...(ctx.data ?? {}) };
            if (event.type === 'reconnecting') {
              next[event.connectionId] = {
                attempt: event.attempt,
                delayMs: event.delayMs,
                scheduledAt: Date.now(),
              };
              ctx.set(next);
            } else if (
              event.type === 'connected' ||
              event.type === 'reconnected' ||
              event.type === 'disconnected' ||
              event.type === 'reconnect-failed'
            ) {
              if (event.connectionId in next) {
                delete next[event.connectionId];
                ctx.set(next);
              }
            }
          },
        },
      ],
      { init: {} }
    );

    makeObservable<K8sConnectionStore, 'pendingMutations'>(this, {
      pendingMutations: observable,
      connections: computed,
      connectionStates: computed,
      healthStates: computed,
      reconnectInfos: computed,
      isLoading: computed,
      start: action,
      dispose: action,
    });
  }

  get connections(): K8sConfig[] {
    return this.connectionsResource.data ?? [];
  }

  get connectionStates(): Record<string, ConnectionState> {
    return this.connectionStatesResource.data ?? {};
  }

  get healthStates(): Record<string, K8sHealthState> {
    return this.healthStatesResource.data ?? {};
  }

  get reconnectInfos(): Record<string, K8sReconnectInfo> {
    return this.reconnectInfoResource.data ?? {};
  }

  get isLoading(): boolean {
    return (
      this.connectionsResource.loading ||
      this.connectionStatesResource.loading ||
      this.healthStatesResource.loading ||
      this.pendingMutations > 0
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connectionStatesResource.start();
    this.healthStatesResource.start();
    this.reconnectInfoResource.start();
    void this.connectionsResource.load();
  }

  dispose(): void {
    this.connectionsResource.dispose();
    this.connectionStatesResource.dispose();
    this.healthStatesResource.dispose();
    this.reconnectInfoResource.dispose();
    this.started = false;
  }

  stateFor(connectionId: string): ConnectionState {
    return this.connectionStates[connectionId] ?? 'disconnected';
  }

  healthFor(connectionId: string): K8sHealthState {
    return this.healthStates[connectionId] ?? { status: 'ok' };
  }

  reconnectInfoFor(connectionId: string): K8sReconnectInfo | null {
    return this.reconnectInfos[connectionId] ?? null;
  }

  async connect(connectionId: string): Promise<void> {
    const state = this.stateFor(connectionId);
    if (state === 'connected' || state === 'connecting' || state === 'reconnecting') {
      return;
    }
    await rpc.k8s.connect(connectionId);
  }

  /**
   * Force an immediate reconnect, resetting any backoff countdown. Unlike
   * connect(), this re-verifies even a connection that still looks alive.
   */
  async reconnect(connectionId: string): Promise<void> {
    await rpc.k8s.reconnect(connectionId);
  }

  async saveConnection(config: SaveConnectionInput): Promise<K8sConfig> {
    return await this.withMutation(async () => {
      const savedConnection = await rpc.k8s.saveConnection(config);
      this.connectionsResource.setValue(this.upsertConnection(savedConnection));
      return savedConnection;
    });
  }

  async getContexts(kubeconfigPath?: string): Promise<K8sConfigContext[]> {
    return await rpc.k8s.listContexts(kubeconfigPath);
  }

  async browsePath(input: string): ReturnType<typeof rpc.k8s.browsePath> {
    return await rpc.k8s.browsePath(input);
  }

  async getNamespaces(context: string, kubeconfigPath?: string): Promise<string[]> {
    return await rpc.k8s.listNamespaces({ context, kubeconfigPath });
  }

  async getPods(
    context: string,
    namespace: string,
    kubeconfigPath?: string
  ): ReturnType<typeof rpc.k8s.listPods> {
    return await rpc.k8s.listPods({ context, namespace, kubeconfigPath });
  }

  async renameConnection(id: string, name: string): Promise<void> {
    await this.withMutation(async () => {
      await rpc.k8s.renameConnection(id, name);
      const current = this.connectionsResource.data ?? [];
      this.connectionsResource.setValue(
        current.map((connection) => (connection.id === id ? { ...connection, name } : connection))
      );
    });
  }

  async deleteConnection(id: string): Promise<void> {
    await this.withMutation(async () => {
      await rpc.k8s.deleteConnection(id);

      const currentConnections = this.connectionsResource.data ?? [];
      this.connectionsResource.setValue(
        currentConnections.filter((connection) => connection.id !== id)
      );

      const currentStates = this.connectionStatesResource.data ?? {};
      if (id in currentStates) {
        const { [id]: _removed, ...rest } = currentStates;
        this.connectionStatesResource.setValue(rest);
      }

      const currentHealthStates = this.healthStatesResource.data ?? {};
      if (id in currentHealthStates) {
        const { [id]: _removed, ...rest } = currentHealthStates;
        this.healthStatesResource.setValue(rest);
      }

      const currentReconnectInfos = this.reconnectInfoResource.data ?? {};
      if (id in currentReconnectInfos) {
        const { [id]: _removed, ...rest } = currentReconnectInfos;
        this.reconnectInfoResource.setValue(rest);
      }
    });
  }

  async testConnection(config: K8sConfig & { token?: string }): Promise<ConnectionTestResult> {
    return await rpc.k8s.testConnection(config);
  }

  private upsertConnection(savedConnection: K8sConfig): K8sConfig[] {
    const current = this.connectionsResource.data ?? [];
    const index = current.findIndex((connection) => connection.id === savedConnection.id);
    if (index === -1) return [...current, savedConnection];

    const next = [...current];
    next[index] = savedConnection;
    return next;
  }

  private async withMutation<T>(run: () => Promise<T>): Promise<T> {
    runInAction(() => {
      this.pendingMutations += 1;
    });

    try {
      return await run();
    } finally {
      runInAction(() => {
        this.pendingMutations = Math.max(0, this.pendingMutations - 1);
      });
    }
  }
}
