import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import type { K8sProject, LocalProject, Project, SshProject } from '@shared/projects';

type ProjectRow = typeof projects.$inferSelect;

function mapRowToProject(row: ProjectRow): Project {
  if (row.workspaceProvider === 'local') {
    return {
      type: 'local' as const,
      id: row.id,
      name: row.name,
      path: row.path,
      baseRef: row.baseRef ?? 'main',
      repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  if (row.workspaceProvider === 'k8s') {
    return {
      type: 'k8s' as const,
      id: row.id,
      name: row.name,
      path: row.path,
      baseRef: row.baseRef ?? 'main',
      connectionId: row.k8sConnectionId!,
      repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  return {
    type: 'ssh' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    connectionId: row.sshConnectionId!,
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getProjects(): Promise<Project[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  return rows.map(mapRowToProject);
}

export async function getProjectById(projectId: string): Promise<Project | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) return undefined;
  return mapRowToProject(row);
}

export async function getLocalProjectByPath(path: string): Promise<LocalProject | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.path, path)).limit(1);
  if (!row) return undefined;
  return {
    type: 'local' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getSshProjectByPath(
  path: string,
  connectionId: string
): Promise<SshProject | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.path, path), eq(projects.sshConnectionId, connectionId)))
    .limit(1);
  if (!row) return undefined;
  return {
    type: 'ssh' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    connectionId: row.sshConnectionId!,
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getK8sProjectByPath(
  path: string,
  connectionId: string
): Promise<K8sProject | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.path, path), eq(projects.k8sConnectionId, connectionId)))
    .limit(1);
  if (!row) return undefined;
  return {
    type: 'k8s' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    connectionId: row.k8sConnectionId!,
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
