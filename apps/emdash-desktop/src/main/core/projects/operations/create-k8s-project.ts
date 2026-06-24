import { randomUUID } from 'node:crypto';
import { err, ok } from '@emdash/shared';
import { sql } from 'drizzle-orm';
import { K8sFileSystem } from '@main/core/fs/impl/k8s-fs';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { CreateProjectResult, ProjectPathStatus } from '@shared/projects';
import { ensureProjectRepository } from './create-project-utils';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';

export type CreateK8sProjectParams = {
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export async function createK8sProject(
  params: CreateK8sProjectParams
): Promise<CreateProjectResult> {
  const proxy = await kubeConnectionManager.connect(params.connectionId);

  const k8sFs = new K8sFileSystem(proxy, params.path);
  const pathEntry = await k8sFs.stat('');
  if (!pathEntry || pathEntry.type !== 'dir') {
    return err({
      type: 'invalid-directory',
      path: params.path,
      message: 'Invalid directory',
    });
  }
  const runtimeLease = await runtimeManager.acquire({
    kind: 'k8s',
    connectionId: params.connectionId,
  });
  const repositoryResult = await ensureProjectRepository(
    runtimeLease.value.git,
    params.path,
    params.initGitRepository
  ).finally(() => runtimeLease.release());
  if (!repositoryResult.success) return repositoryResult;
  const gitInfo = repositoryResult.data;

  const [row] = await db
    .insert(projects)
    .values({
      id: params.id ?? randomUUID(),
      name: params.name,
      path: gitInfo.rootPath,
      workspaceProvider: 'k8s',
      k8sConnectionId: params.connectionId,
      baseRef: gitInfo.baseRef,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  const project = {
    type: 'k8s' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    connectionId: params.connectionId,
    baseRef: row.baseRef ?? gitInfo.baseRef,
    repositoryWorkspaceId: null as string | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  await projectManager.openProject(project);

  try {
    project.repositoryWorkspaceId = ensureRepositoryWorkspace(project);
  } catch (error) {
    log.warn('createK8sProject: ensureRepositoryWorkspace failed (non-fatal)', {
      projectId: project.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  projectEvents._emit('project:created', project);

  return ok(project);
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

    const runtimeLease = await runtimeManager.acquire({ kind: 'k8s', connectionId });
    try {
      const inspection = await runtimeLease.value.git.inspectPath(path);
      return { isDirectory: true, isGitRepo: inspection.kind === 'repository' };
    } finally {
      runtimeLease.release();
    }
  } catch {
    return { isDirectory: false, isGitRepo: false };
  }
}
