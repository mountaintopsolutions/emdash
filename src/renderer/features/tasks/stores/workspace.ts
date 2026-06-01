import { computed, makeObservable } from 'mobx';
import type { ProjectSettingsStore } from '@renderer/features/projects/stores/project-settings-store';
import { RepositoryStore } from '@renderer/features/projects/stores/repository-store';
import { appState } from '@renderer/lib/stores/app-state';
import type { ILifecycle } from '@renderer/lib/stores/lifecycle';
import type { ConnectionState } from '@shared/ssh';
import { GitStore } from '../diff-view/stores/git-store';
import { FilesStore } from '../editor/stores/files-store';
import { LifecycleScriptsStore } from './lifecycle-scripts';

/** Identifies the remote transport backing a workspace, if any. */
export type RemoteConnection = { kind: 'ssh' | 'k8s'; id: string };

export class WorkspaceStore implements ILifecycle {
  readonly path: string;
  readonly repository: RepositoryStore;
  readonly remoteConnection: RemoteConnection | undefined;
  readonly git: GitStore;
  readonly files: FilesStore;
  readonly lifecycleScripts: LifecycleScriptsStore;

  constructor(
    projectId: string,
    workspaceId: string,
    path: string,
    settingsStore: ProjectSettingsStore,
    baseRef: string,
    remoteConnection?: RemoteConnection
  ) {
    makeObservable(this, { connectionState: computed });
    this.path = path;
    this.remoteConnection = remoteConnection;
    this.repository = new RepositoryStore(projectId, settingsStore, baseRef, workspaceId);
    this.git = new GitStore(projectId, workspaceId, this.repository);
    this.files = new FilesStore(projectId, workspaceId);
    this.lifecycleScripts = new LifecycleScriptsStore(projectId, workspaceId);
  }

  /** The remote connection id regardless of transport, or undefined when local. */
  get remoteConnectionId(): string | undefined {
    return this.remoteConnection?.id;
  }

  private get connectionStore() {
    if (!this.remoteConnection) return null;
    return this.remoteConnection.kind === 'k8s' ? appState.k8sConnections : appState.sshConnections;
  }

  get connectionState(): ConnectionState | null {
    if (!this.remoteConnection) return null;
    return this.connectionStore?.stateFor(this.remoteConnection.id) ?? null;
  }

  reconnect(): void {
    if (this.remoteConnection) {
      void this.connectionStore?.connect(this.remoteConnection.id).catch(() => {});
    }
  }

  activate(): void {
    this.git.startWatching();
    this.files.startWatching();
  }

  initialize(): void {
    this.activate();
  }

  dispose(): void {
    this.repository.dispose();
    this.git.dispose();
    this.files.dispose();
    this.lifecycleScripts.dispose();
  }
}
