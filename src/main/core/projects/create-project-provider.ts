import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { K8sExecutionContext } from '@main/core/execution-context/k8s-execution-context';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { K8sFileSystem } from '@main/core/fs/impl/k8s-fs';
import { LocalFileSystem } from '@main/core/fs/impl/local-fs';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { FileSystemProvider } from '@main/core/fs/types';
import { GitFetchService } from '@main/core/git/git-fetch-service';
import { GitService } from '@main/core/git/impl/git-service';
import { GitRepositoryService } from '@main/core/git/repository-service';
import { k8sConfigFromRow } from '@main/core/k8s/config/connection-metadata';
import type { KubeConnectionManagerEvent } from '@main/core/k8s/lifecycle/kube-connection-manager';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import type { SshConnectionManagerEvent } from '@main/core/ssh/lifecycle/ssh-connection-manager';
import { db } from '@main/db/client';
import { k8sConnections as k8sConnectionsTable } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { safePathSegment } from '@shared/path-name';
import type { K8sProject, LocalProject, SshProject } from '@shared/projects';
import { ProjectProvider, type ProjectProviderTransport } from './project-provider';
import type { ProjectSettingsProvider } from './settings/provider';
import { K8sProjectSettingsProvider } from './settings/providers/k8s-project-settings-provider';
import { LocalProjectSettingsProvider } from './settings/providers/local-project-settings-provider';
import { SshProjectSettingsProvider } from './settings/providers/ssh-project-settings-provider';
import { K8sWorktreeHost } from './worktrees/hosts/k8s-worktree-host';
import { LocalWorktreeHost } from './worktrees/hosts/local-worktree-host';
import { SshWorktreeHost } from './worktrees/hosts/ssh-worktree-host';
import type { WorktreeHost } from './worktrees/hosts/worktree-host';
import { WorktreeService } from './worktrees/worktree-service';

export async function createProvider(
  project: LocalProject | SshProject | K8sProject
): Promise<ProjectProvider> {
  if (project.type === 'ssh') {
    return createSshProvider(project);
  }
  if (project.type === 'k8s') {
    return createK8sProvider(project);
  }
  return createLocalProvider(project);
}

async function createLocalProvider(project: LocalProject): Promise<ProjectProvider> {
  const localFs = new LocalFileSystem(project.path);
  const baseCtx = new LocalExecutionContext({ root: project.path });
  const ctx = baseCtx;
  const repoGit = new GitService(ctx, localFs);

  const settings = new LocalProjectSettingsProvider(project.id, project.path, project.baseRef, {
    git: repoGit,
  });
  const worktreeDirectory = await settings.getWorktreeDirectory();
  await fs.promises.mkdir(worktreeDirectory, { recursive: true });
  const worktreeHost = await LocalWorktreeHost.create({
    allowedRoots: [project.path, worktreeDirectory],
  });
  const resolveWorktreePoolPath = async () => {
    const directory = await settings.getWorktreeDirectory();
    await fs.promises.mkdir(directory, { recursive: true });
    await worktreeHost.allowRoot(directory);
    return path.join(directory, safePathSegment(project.name, project.id));
  };

  return buildProvider(
    project.id,
    project.path,
    { kind: 'local', defaultWorkspaceType: { kind: 'local' }, ctx },
    localFs,
    repoGit,
    settings,
    worktreeHost,
    resolveWorktreePoolPath,
    () => {}
  );
}

async function createSshProvider(project: SshProject): Promise<ProjectProvider> {
  try {
    const proxy = await sshConnectionManager.connect(project.connectionId);
    const rootFs = new SshFileSystem(proxy, '/');
    const projectFs = new SshFileSystem(proxy, project.path);

    const baseCtx = new SshExecutionContext(proxy, { root: project.path });
    const ctx = baseCtx;
    const repoGit = new GitService(ctx, projectFs);

    const settings = new SshProjectSettingsProvider(
      project.id,
      projectFs,
      project.baseRef,
      rootFs,
      project.path,
      baseCtx,
      {
        git: repoGit,
      }
    );
    const worktreeDirectory = await settings.getWorktreeDirectory();
    const worktreePoolPath = path.posix.join(worktreeDirectory, project.name);
    const worktreeHost = new SshWorktreeHost(rootFs);
    await worktreeHost.mkdirAbsolute(worktreePoolPath, { recursive: true });
    const resolveWorktreePoolPath = async () =>
      path.posix.join(await settings.getWorktreeDirectory(), project.name);

    const dispose = () => sshConnectionManager.off('connection-event', handler);

    const provider = buildProvider(
      project.id,
      project.path,
      {
        kind: 'ssh',
        defaultWorkspaceType: { kind: 'ssh', proxy, connectionId: project.connectionId },
        ctx,
      },
      projectFs,
      repoGit,
      settings,
      worktreeHost,
      resolveWorktreePoolPath,
      dispose
    );

    // Wire reconnect handler after provider is built so gitFetchService is available.
    const handler = (evt: SshConnectionManagerEvent) => {
      if (evt.type === 'reconnected' && evt.connectionId === project.connectionId) {
        void provider.gitFetchService.fetch();
      }
    };
    sshConnectionManager.on('connection-event', handler);

    return provider;
  } catch (error) {
    log.warn('createSshProvider: SSH connection failed', {
      projectId: project.id,
      error: error instanceof Error ? error.message : String(error),
    });
    sshConnectionManager.reportChannelError(project.connectionId, error);
    throw error;
  }
}

async function createK8sProvider(project: K8sProject): Promise<ProjectProvider> {
  try {
    const proxy = await kubeConnectionManager.connect(project.connectionId);

    // Load the connection's tmux preference (defaults ON for k8s when unset) so
    // agent/terminal sessions re-attach instead of respawning on exec-stream reconnect.
    const [connectionRow] = await db
      .select()
      .from(k8sConnectionsTable)
      .where(eq(k8sConnectionsTable.id, project.connectionId))
      .limit(1);
    const connectionConfig = connectionRow ? k8sConfigFromRow(connectionRow) : undefined;
    const connectionTmux = connectionConfig?.tmux;
    const connectionShell = connectionConfig?.shell;

    const rootFs = new K8sFileSystem(proxy, '/');
    const projectFs = new K8sFileSystem(proxy, project.path);

    const baseCtx = new K8sExecutionContext(proxy, { root: project.path });
    const ctx = baseCtx;
    const repoGit = new GitService(ctx, projectFs);

    const settings = new K8sProjectSettingsProvider(
      project.id,
      projectFs,
      project.baseRef,
      rootFs,
      project.path,
      baseCtx,
      {
        git: repoGit,
      }
    );
    const worktreeDirectory = await settings.getWorktreeDirectory();
    const worktreePoolPath = path.posix.join(worktreeDirectory, project.name);
    const worktreeHost = new K8sWorktreeHost(rootFs);
    await worktreeHost.mkdirAbsolute(worktreePoolPath, { recursive: true });
    const resolveWorktreePoolPath = async () =>
      path.posix.join(await settings.getWorktreeDirectory(), project.name);

    const dispose = () => kubeConnectionManager.off('connection-event', handler);

    const provider = buildProvider(
      project.id,
      project.path,
      {
        kind: 'k8s',
        defaultWorkspaceType: {
          kind: 'k8s',
          proxy,
          connectionId: project.connectionId,
          tmux: connectionTmux,
          shell: connectionShell,
        },
        ctx,
      },
      projectFs,
      repoGit,
      settings,
      worktreeHost,
      resolveWorktreePoolPath,
      dispose
    );

    // Wire reconnect handler after provider is built so gitFetchService is available.
    const handler = (evt: KubeConnectionManagerEvent) => {
      if (evt.type === 'reconnected' && evt.connectionId === project.connectionId) {
        void provider.gitFetchService.fetch();
      }
    };
    kubeConnectionManager.on('connection-event', handler);

    return provider;
  } catch (error) {
    log.warn('createK8sProvider: Kubernetes connection failed', {
      projectId: project.id,
      error: error instanceof Error ? error.message : String(error),
    });
    kubeConnectionManager.reportChannelError(project.connectionId, error);
    throw error;
  }
}

function buildProvider(
  projectId: string,
  repoPath: string,
  transportMeta: Pick<ProjectProviderTransport, 'kind' | 'defaultWorkspaceType' | 'ctx'>,
  projectFs: FileSystemProvider,
  repoGit: GitService,
  settings: ProjectSettingsProvider,
  worktreeHost: WorktreeHost,
  resolveWorktreePoolPath: () => Promise<string>,
  dispose: () => void
): ProjectProvider {
  const { ctx } = transportMeta;

  const transport: ProjectProviderTransport = {
    ...transportMeta,
    fs: projectFs,
    settings,
    worktreeHost,
  };

  const repository = new GitRepositoryService(repoGit, settings);
  const worktreeService = new WorktreeService({
    repoPath,
    projectSettings: settings,
    ctx,
    host: worktreeHost,
    resolveWorktreePoolPath,
  });
  const gitFetchService = new GitFetchService(repoGit, () => repository.getBaseRemote());
  gitFetchService.start();

  return new ProjectProvider(
    projectId,
    repoPath,
    transport,
    repository,
    worktreeService,
    gitFetchService,
    dispose
  );
}
