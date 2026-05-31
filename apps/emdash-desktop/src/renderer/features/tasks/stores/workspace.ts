import type { ILifecycle } from '@emdash/shared';
import { computed, makeObservable } from 'mobx';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import { appState } from '@renderer/lib/stores/app-state';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import { FilesStore } from '../editor/stores/files-store';
import { GitWorktreeStore } from './git-worktree-store';
import { LifecycleScriptsStore } from './lifecycle-scripts';

/** Identifies the remote transport backing a workspace, if any. */
export type RemoteConnection = { kind: 'ssh' | 'k8s'; id: string };

export class WorkspaceStore implements ILifecycle {
  readonly path: string;
  readonly gitRepository: GitRepositoryStore;
  readonly remoteConnection: RemoteConnection | undefined;
  readonly gitWorktree: GitWorktreeStore;
  readonly files: FilesStore;
  readonly lifecycleScripts: LifecycleScriptsStore;

  constructor(
    projectId: string,
    workspaceId: string,
    path: string,
    gitRepository: GitRepositoryStore,
    remoteConnection?: RemoteConnection
  ) {
    makeObservable(this, { connectionState: computed });
    this.path = path;
    this.remoteConnection = remoteConnection;
    this.gitRepository = gitRepository;
    this.gitWorktree = new GitWorktreeStore(projectId, workspaceId, this.gitRepository);
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
    this.gitWorktree.start();
    this.files.startWatching();
  }

  initialize(): void {
    this.activate();
  }

  dispose(): void {
    this.gitWorktree.dispose();
    this.files.dispose();
    this.lifecycleScripts.dispose();
  }
}
