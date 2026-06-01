import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { K8sExecutionContext } from '@main/core/execution-context/k8s-execution-context';
import { K8sFileSystem } from '@main/core/fs/impl/k8s-fs';
import { GitService } from '@main/core/git/impl/git-service';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import type { K8sProject, ProjectPathStatus } from '@shared/projects';
import { ensureGitRepository, resolveProjectBaseRef } from './create-project-utils';

export type CreateK8sProjectParams = {
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export async function createK8sProject(params: CreateK8sProjectParams): Promise<K8sProject> {
  const proxy = await kubeConnectionManager.connect(params.connectionId);

  const k8sFs = new K8sFileSystem(proxy, params.path);
  const pathEntry = await k8sFs.stat('');
  if (!pathEntry || pathEntry.type !== 'dir') {
    throw new Error('Invalid directory');
  }
  const baseK8sCtx = new K8sExecutionContext(proxy, { root: params.path });
  const git = new GitService(baseK8sCtx, k8sFs);

  const gitInfo = await ensureGitRepository(git, params.initGitRepository);
  const baseRef = await resolveProjectBaseRef(git, gitInfo.baseRef);

  const [row] = await db
    .insert(projects)
    .values({
      id: params.id ?? randomUUID(),
      name: params.name,
      path: gitInfo.rootPath,
      workspaceProvider: 'k8s',
      k8sConnectionId: params.connectionId,
      baseRef,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  const project = {
    type: 'k8s' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    connectionId: params.connectionId,
    baseRef: row.baseRef ?? baseRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  await projectManager.openProject(project);
  projectEvents._emit('project:created', project);

  return project;
}

export async function getK8sProjectPathStatus(
  path: string,
  connectionId: string
): Promise<ProjectPathStatus> {
  try {
    const proxy = await kubeConnectionManager.connect(connectionId);
    const k8sFs = new K8sFileSystem(proxy, path);
    const pathEntry = await k8sFs.stat('');
    if (!pathEntry || pathEntry.type !== 'dir') {
      return { isDirectory: false, isGitRepo: false };
    }

    const baseK8sCtx = new K8sExecutionContext(proxy, { root: path });
    const git = new GitService(baseK8sCtx, k8sFs);
    const gitInfo = await git.detectInfo();
    return { isDirectory: true, isGitRepo: gitInfo.isGitRepo };
  } catch {
    return { isDirectory: false, isGitRepo: false };
  }
}
