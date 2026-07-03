import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { clearDependencyManager } from '@main/core/dependencies/dependency-managers';
import { K8sFileSystem } from '@main/core/fs/impl/k8s-fs';
import { db } from '@main/db/client';
import {
  k8sConnections as k8sConnectionsTable,
  type K8sConnectionInsert,
  projects,
} from '@main/db/schema';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import type {
  ConnectionTestResult,
  FileEntry,
  K8sConfig,
  K8sConfigContext,
  K8sConnectionUsage,
  K8sHealthState,
  LocalPathListing,
} from '@shared/kubernetes';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  k8sConfigFromRow,
  mergeK8sConnectionMetadata,
  parseK8sConnectionMetadata,
  serializeK8sConnectionMetadata,
  type K8sConnectionMetadata,
} from './config/connection-metadata';
import {
  listKubeConfigContexts,
  listNamespacesForContext,
  listPodsForContext,
  type K8sPodEntry,
} from './config/kubeconfig-parser';
import { browseLocalPath } from './config/local-path-browser';
import { testProductionK8sConnection } from './connect/production-test-connection';
import { k8sCredentialService } from './credentials/k8s-credential-service';
import { kubeConnectionManager } from './lifecycle/production-kube-connection-manager';

export const k8sController = createRPCController({
  /** List all saved Kubernetes connections (no secrets). */
  getConnections: async (): Promise<K8sConfig[]> => {
    const rows = await db.select().from(k8sConnectionsTable);
    return rows.map(k8sConfigFromRow);
  },

  /** List contexts defined in a kubeconfig (default chain when no path given). */
  listContexts: async (kubeconfigPath?: string): Promise<K8sConfigContext[]> => {
    return listKubeConfigContexts(kubeconfigPath);
  },

  /** Browse the local filesystem for the kubeconfig path picker (~ is expanded). */
  browsePath: async (input: string): Promise<LocalPathListing> => {
    return browseLocalPath(input);
  },

  /** List namespaces visible to the given context. */
  listNamespaces: async ({
    context,
    kubeconfigPath,
  }: {
    context: string;
    kubeconfigPath?: string;
  }): Promise<string[]> => {
    return listNamespacesForContext(context, kubeconfigPath);
  },

  /** List pods (and their containers) in a namespace for the given context. */
  listPods: async ({
    context,
    namespace,
    kubeconfigPath,
  }: {
    context: string;
    namespace: string;
    kubeconfigPath?: string;
  }): Promise<K8sPodEntry[]> => {
    return listPodsForContext(context, namespace, kubeconfigPath);
  },

  /** List projects currently using each saved Kubernetes connection. */
  getConnectionUsage: async (): Promise<K8sConnectionUsage> => {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        k8sConnectionId: projects.k8sConnectionId,
      })
      .from(projects);

    const usage: K8sConnectionUsage = {};
    for (const row of rows) {
      if (!row.k8sConnectionId) continue;
      usage[row.k8sConnectionId] ??= [];
      usage[row.k8sConnectionId].push({ id: row.id, name: row.name });
    }
    return usage;
  },

  /** Create or update a Kubernetes connection, storing any token in secure storage. */
  saveConnection: async (
    config: Partial<Pick<K8sConfig, 'id'>> & Omit<K8sConfig, 'id'> & { token?: string }
  ): Promise<K8sConfig> => {
    const connectionId = config.id ?? randomUUID();

    // Only update the stored token when a non-empty value is provided.
    // On edits, leaving it blank means "keep the existing credential".
    if (config.token) {
      await k8sCredentialService.storeToken(connectionId, config.token);
    }

    const { token: _token, ...dbConfig } = config;

    const existingMetadata =
      config.id === undefined
        ? {}
        : parseK8sConnectionMetadata(
            (
              await db
                .select({ metadata: k8sConnectionsTable.metadata })
                .from(k8sConnectionsTable)
                .where(eq(k8sConnectionsTable.id, connectionId))
                .limit(1)
            )[0]?.metadata ?? null
          );

    const metadataUpdate: K8sConnectionMetadata = {};
    if (Object.prototype.hasOwnProperty.call(config, 'kubeconfigPath')) {
      metadataUpdate.kubeconfigPath = config.kubeconfigPath;
    }
    if (Object.prototype.hasOwnProperty.call(config, 'tmux')) {
      metadataUpdate.tmux = config.tmux;
    }
    if (Object.prototype.hasOwnProperty.call(config, 'shell')) {
      metadataUpdate.shell = config.shell;
    }
    const metadata = mergeK8sConnectionMetadata(existingMetadata, metadataUpdate);

    const insertData: K8sConnectionInsert = {
      id: connectionId,
      name: dbConfig.name,
      context: dbConfig.context,
      namespace: dbConfig.namespace,
      podName: dbConfig.podName,
      containerName: dbConfig.containerName ?? null,
      kubeconfigPath: dbConfig.kubeconfigPath ?? null,
      metadata: serializeK8sConnectionMetadata(metadata),
    };

    await db
      .insert(k8sConnectionsTable)
      .values(insertData)
      .onConflictDoUpdate({
        target: k8sConnectionsTable.id,
        set: {
          name: insertData.name,
          context: insertData.context,
          namespace: insertData.namespace,
          podName: insertData.podName,
          containerName: insertData.containerName,
          kubeconfigPath: insertData.kubeconfigPath,
          metadata: insertData.metadata,
          updatedAt: new Date().toISOString(),
        },
      });

    return {
      ...dbConfig,
      id: connectionId,
      kubeconfigPath: dbConfig.kubeconfigPath ?? metadata.kubeconfigPath,
      tmux: metadata.tmux,
      shell: metadata.shell,
    };
  },

  /** Delete a saved Kubernetes connection and its stored credentials. */
  deleteConnection: async (id: string): Promise<void> => {
    const referencingProjects = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.k8sConnectionId, id));

    if (referencingProjects.length > 0) {
      const projectNames = referencingProjects.map((project) => project.name).join(', ');
      throw new Error(`Kubernetes connection is used by ${projectNames}`);
    }

    clearDependencyManager(id);
    if (kubeConnectionManager.getConnectionState(id) !== 'disconnected') {
      await kubeConnectionManager.disconnect(id).catch((e) => {
        log.warn('k8sController.deleteConnection: error disconnecting', {
          connectionId: id,
          error: String(e),
        });
      });
    }
    await k8sCredentialService.deleteAllCredentials(id);
    await db.delete(k8sConnectionsTable).where(eq(k8sConnectionsTable.id, id));
  },

  /** Test a connection without persisting anything. */
  testConnection: async (config: K8sConfig & { token?: string }): Promise<ConnectionTestResult> => {
    const result = await testProductionK8sConnection(config);
    telemetryService.capture('k8s_connection_attempted', { success: result.success });
    return result;
  },

  /** Intentionally close a connection and stop auto-reconnect. */
  disconnect: async (connectionId: string): Promise<void> => {
    clearDependencyManager(connectionId);
    await kubeConnectionManager.disconnect(connectionId);
  },

  /** Ensure a connection is established (no-op if already connected). */
  connect: async (connectionId: string): Promise<ConnectionState> => {
    await kubeConnectionManager.connect(connectionId);
    return kubeConnectionManager.getConnectionState(connectionId);
  },

  /** Force an immediate reconnect, resetting any backoff countdown. */
  reconnect: async (connectionId: string): Promise<ConnectionState> => {
    await kubeConnectionManager.reconnect(connectionId);
    return kubeConnectionManager.getConnectionState(connectionId);
  },

  /** Returns whether the connection is currently live. */
  getState: async (connectionId: string): Promise<'connected' | 'disconnected'> => {
    return kubeConnectionManager.isConnected(connectionId) ? 'connected' : 'disconnected';
  },

  /** Returns the current ConnectionState for every connection tracked by the manager. */
  getConnectionState: async (): Promise<Record<string, ConnectionState>> => {
    return kubeConnectionManager.getAllConnectionStates();
  },

  getHealthStates: async (): Promise<Record<string, K8sHealthState>> => {
    return kubeConnectionManager.getAllHealthStates();
  },

  /** Rename a saved Kubernetes connection without changing any other fields. */
  renameConnection: async (id: string, name: string): Promise<void> => {
    const [row] = await db.select().from(k8sConnectionsTable).where(eq(k8sConnectionsTable.id, id));
    if (!row) throw new Error(`Kubernetes connection ${id} not found`);
    await db
      .update(k8sConnectionsTable)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(k8sConnectionsTable.id, id));
  },

  /** List files/directories at an in-pod path via exec. */
  listFiles: async ({
    connectionId,
    path: remotePath,
  }: {
    connectionId: string;
    path: string;
  }): Promise<FileEntry[]> => {
    let proxy = kubeConnectionManager.getProxy(connectionId);
    if (!proxy || !proxy.isConnected) {
      proxy = await kubeConnectionManager.connect(connectionId);
    }

    const fs = new K8sFileSystem(proxy, remotePath);
    const result = await fs.list('', { includeHidden: true });
    const base = remotePath.replace(/\/$/, '');
    return result.entries
      .map((item): FileEntry => {
        const name = path.posix.basename(item.path);
        return {
          path: `${base}/${name}`,
          name,
          type: item.type === 'dir' ? 'directory' : 'file',
          size: item.size ?? 0,
          modifiedAt: item.mtime ?? new Date(0),
        };
      })
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
  },

  /** Create a directory (recursively) at an in-pod absolute path. */
  createDirectory: async ({
    connectionId,
    path: remotePath,
  }: {
    connectionId: string;
    path: string;
  }): Promise<void> => {
    let proxy = kubeConnectionManager.getProxy(connectionId);
    if (!proxy || !proxy.isConnected) {
      proxy = await kubeConnectionManager.connect(connectionId);
    }
    const fs = new K8sFileSystem(proxy, '/');
    await fs.mkdir(remotePath, { recursive: true });
  },
});
