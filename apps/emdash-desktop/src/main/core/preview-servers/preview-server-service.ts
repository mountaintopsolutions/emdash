import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import type {
  DirectPreviewServer,
  DirectPreviewServerHost,
  ManualPreviewServerError,
  ManualPreviewServerRequest,
  ManualPreviewServerResult,
  PreviewServer,
  PreviewServerEvent,
  PreviewServerProtocol,
  PreviewServerSource,
} from '@shared/core/preview-servers/types';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import type { KubeConnectionManagerEvent } from '../k8s/lifecycle/kube-connection-manager';
import { PortForwardService } from '../port-forwards/port-forward-service';
import type { PortForwardRecord } from '../port-forwards/port-forward-service';
import type {
  K8sPortForwardProxy,
  SshPortForwardProxy,
} from '../port-forwards/port-forward-tunnel';
import type { SshConnectionManagerEvent } from '../ssh/lifecycle/ssh-connection-manager';
import type { DetectedPreviewUrl, PreviewSourceClosed } from './terminal-url-detector';

/** Remote transports that forward a preview through a port-forward tunnel. */
type RemoteTransport = 'ssh' | 'k8s';

/** A live proxy paired with its transport tag so a caller can re-narrow it. */
type ResolvedProxy =
  | { transport: 'ssh'; proxy: SshPortForwardProxy }
  | { transport: 'k8s'; proxy: K8sPortForwardProxy };

export type RegisterDetectedPreviewTarget =
  | {
      projectId: string;
      workspaceId: string;
      transport: 'local';
      source: PreviewServerSource;
      protocol: PreviewServerProtocol;
      host: DirectPreviewServerHost;
      port: number;
      urlPath: string;
    }
  | {
      projectId: string;
      workspaceId: string;
      transport: 'ssh';
      connectionId: string;
      proxy: SshPortForwardProxy;
      source: PreviewServerSource;
      protocol: PreviewServerProtocol;
      port: number;
      urlPath: string;
    }
  | {
      projectId: string;
      workspaceId: string;
      transport: 'k8s';
      connectionId: string;
      proxy: K8sPortForwardProxy;
      source: PreviewServerSource;
      protocol: PreviewServerProtocol;
      port: number;
      urlPath: string;
    };

export type TerminalSourceClosedInput = {
  projectId: string;
  workspaceId: string;
  terminalId: string;
  transport: 'local' | 'ssh' | 'k8s';
  connectionId?: string;
  reason: PreviewSourceClosed['reason'];
  server?: DetectedPreviewUrl;
};

type PreviewMetadata = {
  identity: string;
  tunnelId?: string;
  /** Remote transport for forwarded previews; absent for direct/local. */
  transport?: RemoteTransport;
};

export class PreviewServerService {
  private readonly servers = new Map<string, PreviewServer>();
  private readonly identities = new Map<string, string>();
  private readonly metadata = new Map<string, PreviewMetadata>();
  private readonly portForwards: PortForwardService;
  private readonly emit: (event: PreviewServerEvent) => void;
  private readonly getConnectionState: (connectionId: string) => ConnectionState;
  private readonly getSshProxy: (connectionId: string) => Promise<SshPortForwardProxy>;
  private readonly getK8sConnectionState: (connectionId: string) => ConnectionState;
  private readonly getK8sProxy: (connectionId: string) => Promise<K8sPortForwardProxy>;
  private readonly closeDelayMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;

  constructor({
    portForwards = new PortForwardService(),
    emit,
    getConnectionState,
    getSshProxy,
    getK8sConnectionState,
    getK8sProxy,
    closeDelayMs = 250,
    healthCheckIntervalMs,
  }: {
    portForwards?: PortForwardService;
    emit: (event: PreviewServerEvent) => void;
    getConnectionState: (connectionId: string) => ConnectionState;
    getSshProxy: (connectionId: string) => Promise<SshPortForwardProxy>;
    getK8sConnectionState?: (connectionId: string) => ConnectionState;
    getK8sProxy?: (connectionId: string) => Promise<K8sPortForwardProxy>;
    closeDelayMs?: number;
    /**
     * When set (> 0), periodically reconcile forwarded preview statuses against
     * live connection state. Omitted in tests so no timer is created.
     */
    healthCheckIntervalMs?: number;
  }) {
    this.portForwards = portForwards;
    this.emit = emit;
    this.getConnectionState = getConnectionState;
    this.getSshProxy = getSshProxy;
    this.getK8sConnectionState =
      getK8sConnectionState ??
      (() => {
        throw new Error('Kubernetes preview forwarding is not configured');
      });
    this.getK8sProxy =
      getK8sProxy ??
      (() => {
        throw new Error('Kubernetes preview forwarding is not configured');
      });
    this.closeDelayMs = closeDelayMs;
    this.portForwards.onConnectionError((tunnelId, error) => {
      void this.handlePortForwardConnectionError(tunnelId, error).catch((handlerError) => {
        log.warn('PreviewServerService: failed to handle preview tunnel connection error', {
          tunnelId,
          error: String(handlerError),
        });
      });
    });
    if (healthCheckIntervalMs && healthCheckIntervalMs > 0) {
      this.healthCheckTimer = setInterval(
        () => this.reconcileForwardedStatuses(),
        healthCheckIntervalMs
      );
      // Don't keep the process alive solely for this poller.
      this.healthCheckTimer.unref?.();
    }
  }

  /**
   * Periodic safety net: reconcile each forwarded preview's status against its
   * live connection state. Connection lifecycle events normally drive these
   * transitions, but a silently-dropped connection (or a missed event) can leave
   * a preview showing 'ready' over a dead port-forward. This flips such previews
   * to 'reconnecting', and back to 'ready' once the connection returns. Failed
   * and starting previews are left alone (terminal / mid-open). Exposed so the
   * timer is just a thin wrapper that can be driven directly in tests.
   */
  reconcileForwardedStatuses(): void {
    for (const server of this.servers.values()) {
      if (server.kind !== 'forwarded') continue;
      if (server.status.kind !== 'ready' && server.status.kind !== 'reconnecting') continue;
      const transport = this.metadata.get(server.id)?.transport ?? 'ssh';

      let connected: boolean;
      try {
        connected = this.connectionStateFor(transport, server.connectionId) === 'connected';
      } catch {
        // A transport whose state lookup isn't configured can't be reconciled.
        continue;
      }

      if (server.status.kind === 'ready' && !connected) {
        const next: PreviewServer = { ...server, status: { kind: 'reconnecting' } };
        this.servers.set(next.id, next);
        this.emit({ type: 'upsert', server: next });
      } else if (
        server.status.kind === 'reconnecting' &&
        connected &&
        server.localPort !== undefined
      ) {
        const next: PreviewServer = { ...server, status: { kind: 'ready' } };
        this.servers.set(next.id, next);
        this.emit({ type: 'upsert', server: next });
      }
    }
  }

  /** Stop the periodic health-check timer. */
  dispose(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  async registerDetectedTarget(target: RegisterDetectedPreviewTarget): Promise<PreviewServer> {
    if (target.transport === 'local') {
      return this.registerLocalTarget(target);
    }

    return await this.registerRemoteTarget(target);
  }

  private async registerRemoteTarget(
    target: Extract<RegisterDetectedPreviewTarget, { transport: 'ssh' | 'k8s' }>
  ): Promise<PreviewServer> {
    const transport = target.transport;
    const identity = remoteAutoIdentity(transport, target);
    const existing = this.serverForIdentity(identity);
    if (existing) return existing;

    const tunnelId = `preview:${identity}`;
    const server: PreviewServer = {
      id: identity,
      kind: 'forwarded',
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      source: target.source,
      protocol: target.protocol,
      urlPath: target.urlPath,
      status: { kind: 'starting' },
      connectionId: target.connectionId,
      remotePort: target.port,
    };
    this.addServer(identity, server, { identity, tunnelId, transport });

    try {
      const forward = await this.portForwards.open({
        id: tunnelId,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        remotePort: target.port,
        preferredLocalPort: target.port,
        ...(target.transport === 'k8s'
          ? { transport: 'k8s', proxy: target.proxy }
          : { transport: 'ssh', proxy: target.proxy }),
      });
      const current = this.servers.get(server.id);
      if (!current || current.kind !== 'forwarded') {
        await this.portForwards.stop(tunnelId);
        return server;
      }
      const next: PreviewServer = {
        ...current,
        localPort: forward.localPort,
        status: { kind: 'ready' },
      };
      this.servers.set(next.id, next);
      this.emit({ type: 'upsert', server: next });
      return next;
    } catch (error) {
      log.warn('PreviewServerService: failed to open preview tunnel', {
        transport,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        remotePort: target.port,
        error: String(error),
      });
      const current = this.servers.get(server.id);
      if (!current || current.kind !== 'forwarded') return server;
      const next: PreviewServer = {
        ...current,
        status: { kind: 'failed', message: forwardOpenFailedMessage(transport) },
      };
      this.servers.set(next.id, next);
      this.emit({ type: 'upsert', server: next });
      return next;
    }
  }

  listForWorkspace({
    projectId,
    workspaceId,
  }: {
    projectId: string;
    workspaceId: string;
  }): PreviewServer[] {
    return Array.from(this.servers.values()).filter(
      (server) => server.projectId === projectId && server.workspaceId === workspaceId
    );
  }

  async handleTerminalSourceClosed(input: TerminalSourceClosedInput): Promise<void> {
    if (input.transport === 'local') {
      await this.stopForTerminal(input);
      return;
    }

    if (input.reason !== 'pty-exit' || !input.connectionId) return;
    const transport = input.transport;
    const connectionId = input.connectionId;
    setTimeout(() => {
      if (this.connectionStateFor(transport, connectionId) === 'connected') {
        void this.stopForTerminal(input);
      }
    }, this.closeDelayMs);
  }

  async forwardManual(request: ManualPreviewServerRequest): Promise<ManualPreviewServerResult> {
    const transport: RemoteTransport = request.transport ?? 'ssh';
    const id = `manual:${randomUUID()}`;
    const tunnelId = `preview:${id}`;
    const server: PreviewServer = {
      id,
      kind: 'forwarded',
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      source: { kind: 'manual' },
      protocol: request.protocol,
      urlPath: '/',
      status: { kind: 'starting' },
      connectionId: request.connectionId,
      remotePort: request.remotePort,
    };
    this.addServer(id, server, { identity: id, tunnelId, transport });

    const proxyResult = await this.resolveManualProxy(transport, request.connectionId);
    if (!proxyResult.success) {
      if (!this.servers.has(id)) return err(manualForwardCancelledError());
      await this.removeFailedManualForward(id);
      return err(proxyResult.error);
    }
    const currentBeforeOpen = this.servers.get(id);
    if (!currentBeforeOpen || currentBeforeOpen.kind !== 'forwarded') {
      return err(manualForwardCancelledError());
    }

    const forwardResult = await this.openManualTunnel({
      id: tunnelId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
      remotePort: request.remotePort,
      preferredLocalPort: request.preferredLocalPort ?? request.remotePort,
      ...(proxyResult.data.transport === 'k8s'
        ? { transport: 'k8s', proxy: proxyResult.data.proxy }
        : { transport: 'ssh', proxy: proxyResult.data.proxy }),
    });
    if (!forwardResult.success) {
      if (!this.servers.has(id)) return err(manualForwardCancelledError());
      await this.removeFailedManualForward(id);
      return err(forwardResult.error);
    }

    const current = this.servers.get(id);
    if (!current || current.kind !== 'forwarded') {
      await this.portForwards.stop(tunnelId);
      return err(manualForwardCancelledError());
    }

    const next: PreviewServer = {
      ...current,
      localPort: forwardResult.data.localPort,
      status: { kind: 'ready' },
    };
    this.servers.set(next.id, next);
    this.emit({ type: 'upsert', server: next });
    return ok(next);
  }

  handleSshConnectionEvent(event: Pick<SshConnectionManagerEvent, 'type' | 'connectionId'>): void {
    this.applyConnectionEvent('ssh', event);
  }

  handleK8sConnectionEvent(event: Pick<KubeConnectionManagerEvent, 'type' | 'connectionId'>): void {
    this.applyConnectionEvent('k8s', event);
  }

  /**
   * Translate a connection lifecycle event into forwarded preview status
   * updates. Only servers whose metadata transport matches the event source are
   * touched, so SSH and k8s connection drops never cross-affect each other even
   * if (improbably) two connection ids collide. Mirrors how a reconnect tears
   * down and re-establishes the underlying tunnel transport.
   */
  private applyConnectionEvent(
    transport: RemoteTransport,
    event: { type: string; connectionId: string }
  ): void {
    if (
      event.type !== 'disconnected' &&
      event.type !== 'reconnecting' &&
      event.type !== 'reconnected' &&
      event.type !== 'reconnect-failed'
    ) {
      return;
    }

    for (const server of this.servers.values()) {
      if (server.kind !== 'forwarded' || server.connectionId !== event.connectionId) continue;
      if (this.metadata.get(server.id)?.transport !== transport) continue;
      if (server.localPort === undefined && server.status.kind === 'failed') continue;
      if (event.type === 'reconnected' && server.localPort === undefined) continue;

      const next =
        event.type === 'disconnected' || event.type === 'reconnecting'
          ? { ...server, status: { kind: 'reconnecting' as const } }
          : event.type === 'reconnected'
            ? { ...server, status: { kind: 'ready' as const } }
            : {
                ...server,
                status: {
                  kind: 'failed' as const,
                  message: reconnectFailedMessage(transport),
                },
              };

      this.servers.set(next.id, next);
      this.emit({ type: 'upsert', server: next });
    }
  }

  async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;
    this.servers.delete(id);
    const metadata = this.metadata.get(id);
    this.metadata.delete(id);
    if (metadata) this.identities.delete(metadata.identity);
    if (metadata?.tunnelId) await this.portForwards.stop(metadata.tunnelId);
    this.emit({ type: 'remove', id });
  }

  async restart(id: string): Promise<PreviewServer | undefined> {
    const server = this.servers.get(id);
    const metadata = this.metadata.get(id);
    if (!server || server.kind !== 'forwarded' || !metadata?.tunnelId) return server;

    const starting: PreviewServer = {
      ...server,
      status: { kind: 'starting' },
    };
    this.servers.set(id, starting);
    this.emit({ type: 'upsert', server: starting });

    const transport: RemoteTransport = metadata.transport ?? 'ssh';
    try {
      await this.portForwards.stop(metadata.tunnelId);
      const resolved = await this.resolveProxy(transport, server.connectionId);
      const forward = await this.portForwards.open({
        id: metadata.tunnelId,
        projectId: server.projectId,
        workspaceId: server.workspaceId,
        connectionId: server.connectionId,
        remotePort: server.remotePort,
        preferredLocalPort: server.localPort ?? server.remotePort,
        ...(resolved.transport === 'k8s'
          ? { transport: 'k8s', proxy: resolved.proxy }
          : { transport: 'ssh', proxy: resolved.proxy }),
      });
      const current = this.servers.get(id);
      if (!current || current.kind !== 'forwarded') {
        await this.portForwards.stop(metadata.tunnelId);
        return starting;
      }
      const next: PreviewServer = {
        ...current,
        localPort: forward.localPort,
        status: { kind: 'ready' },
      };
      this.servers.set(id, next);
      this.emit({ type: 'upsert', server: next });
      return next;
    } catch (error) {
      log.warn('PreviewServerService: failed to restart preview tunnel', {
        transport,
        projectId: server.projectId,
        workspaceId: server.workspaceId,
        connectionId: server.connectionId,
        remotePort: server.remotePort,
        error: String(error),
      });
      const current = this.servers.get(id);
      if (!current || current.kind !== 'forwarded') return starting;
      const next: PreviewServer = {
        ...current,
        status: { kind: 'failed', message: forwardOpenFailedMessage(transport) },
      };
      this.servers.set(id, next);
      this.emit({ type: 'upsert', server: next });
      return next;
    }
  }

  async stopForWorkspace(projectId: string, workspaceId: string): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter((server) => server.projectId === projectId && server.workspaceId === workspaceId)
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  async stopForProject(projectId: string): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter((server) => server.projectId === projectId)
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private registerLocalTarget(
    target: Extract<RegisterDetectedPreviewTarget, { transport: 'local' }>
  ): DirectPreviewServer {
    const identity = localAutoIdentity(target);
    const existing = this.serverForIdentity(identity);
    if (existing) return existing as DirectPreviewServer;

    const server: DirectPreviewServer = {
      id: identity,
      kind: 'direct',
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      source: target.source,
      protocol: target.protocol,
      urlPath: target.urlPath,
      status: { kind: 'ready' },
      host: target.host,
      port: target.port,
    };
    this.addServer(identity, server, { identity });
    return server;
  }

  private async handlePortForwardConnectionError(tunnelId: string, error: Error): Promise<void> {
    const server = this.serverForTunnel(tunnelId);
    if (!server || server.kind !== 'forwarded') return;
    if (server.status.kind === 'failed' && server.localPort === undefined) return;

    log.warn('PreviewServerService: preview tunnel connection failed', {
      projectId: server.projectId,
      workspaceId: server.workspaceId,
      connectionId: server.connectionId,
      remotePort: server.remotePort,
      error: String(error),
    });

    await this.portForwards.stop(tunnelId);
    const current = this.servers.get(server.id);
    if (!current || current.kind !== 'forwarded') return;

    const next: PreviewServer = {
      ...current,
      localPort: undefined,
      status: { kind: 'failed', message: 'Remote preview port is no longer accepting connections' },
    };
    this.servers.set(next.id, next);
    this.emit({ type: 'upsert', server: next });
  }

  private async stopForTerminal(input: {
    projectId: string;
    workspaceId: string;
    terminalId: string;
    server?: DetectedPreviewUrl;
  }): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter(
        (server) =>
          server.projectId === input.projectId &&
          server.workspaceId === input.workspaceId &&
          server.source.kind === 'terminal-output' &&
          server.source.terminalId === input.terminalId &&
          matchesDetectedServer(server, input.server)
      )
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private connectionStateFor(transport: RemoteTransport, connectionId: string): ConnectionState {
    return transport === 'k8s'
      ? this.getK8sConnectionState(connectionId)
      : this.getConnectionState(connectionId);
  }

  /** Resolve the live proxy for a transport, tagged so the caller can re-narrow. */
  private async resolveProxy(
    transport: RemoteTransport,
    connectionId: string
  ): Promise<ResolvedProxy> {
    if (transport === 'k8s') {
      return { transport: 'k8s', proxy: await this.getK8sProxy(connectionId) };
    }
    return { transport: 'ssh', proxy: await this.getSshProxy(connectionId) };
  }

  private async resolveManualProxy(
    transport: RemoteTransport,
    connectionId: string
  ): Promise<Result<ResolvedProxy, ManualPreviewServerError>> {
    try {
      return ok(await this.resolveProxy(transport, connectionId));
    } catch (error) {
      log.warn('PreviewServerService: failed to resolve proxy for manual preview tunnel', {
        transport,
        connectionId,
        error: String(error),
      });
      return err(manualForwardOpenFailedError(transport));
    }
  }

  private async openManualTunnel(
    request: {
      id: string;
      projectId: string;
      workspaceId: string;
      connectionId: string;
      remotePort: number;
      preferredLocalPort: number;
    } & (
      | { transport: 'ssh'; proxy: SshPortForwardProxy }
      | { transport: 'k8s'; proxy: K8sPortForwardProxy }
    )
  ): Promise<Result<PortForwardRecord, ManualPreviewServerError>> {
    try {
      return ok(await this.portForwards.open(request));
    } catch (error) {
      log.warn('PreviewServerService: failed to open manual preview tunnel', {
        transport: request.transport,
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        connectionId: request.connectionId,
        remotePort: request.remotePort,
        error: String(error),
      });
      return err(manualForwardOpenFailedError(request.transport));
    }
  }

  private async removeFailedManualForward(id: string): Promise<void> {
    if (this.servers.has(id)) {
      await this.stop(id);
    }
  }

  private addServer(identity: string, server: PreviewServer, metadata: PreviewMetadata): void {
    this.identities.set(identity, server.id);
    this.servers.set(server.id, server);
    this.metadata.set(server.id, metadata);
    this.emit({ type: 'upsert', server });
  }

  private serverForIdentity(identity: string): PreviewServer | undefined {
    const id = this.identities.get(identity);
    return id ? this.servers.get(id) : undefined;
  }

  private serverForTunnel(tunnelId: string): PreviewServer | undefined {
    for (const [serverId, metadata] of this.metadata.entries()) {
      if (metadata.tunnelId === tunnelId) return this.servers.get(serverId);
    }
    return undefined;
  }
}

function localAutoIdentity(target: {
  projectId: string;
  workspaceId: string;
  host: DirectPreviewServerHost;
  port: number;
}): string {
  return `local:auto:${target.projectId}:${target.workspaceId}:${target.host}:${target.port}`;
}

function remoteAutoIdentity(
  transport: RemoteTransport,
  target: {
    projectId: string;
    workspaceId: string;
    connectionId: string;
    port: number;
  }
): string {
  return `${transport}:auto:${target.projectId}:${target.workspaceId}:${target.connectionId}:${target.port}`;
}

function transportLabel(transport: RemoteTransport): string {
  return transport === 'k8s' ? 'Kubernetes' : 'SSH';
}

function forwardOpenFailedMessage(transport: RemoteTransport): string {
  return `Failed to open ${transportLabel(transport)} port forward`;
}

function reconnectFailedMessage(transport: RemoteTransport): string {
  return `${transportLabel(transport)} connection failed to reconnect`;
}

function manualForwardCancelledError(): ManualPreviewServerError {
  return {
    type: 'cancelled',
    message: 'Manual preview forwarding was cancelled',
  };
}

function manualForwardOpenFailedError(transport: RemoteTransport): ManualPreviewServerError {
  return {
    type: 'open-failed',
    message: forwardOpenFailedMessage(transport),
  };
}

function matchesDetectedServer(
  server: PreviewServer,
  detected: DetectedPreviewUrl | undefined
): boolean {
  if (!detected) return true;
  if (server.protocol !== detected.protocol) return false;
  if (server.kind === 'direct') {
    return server.host === detected.host && server.port === detected.port;
  }
  return server.remotePort === detected.port;
}
