import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';

export async function updateProjectConnection(
  projectId: string,
  connectionId: string
): Promise<void> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) throw new Error(`Project ${projectId} not found`);

  const updatedAt = new Date().toISOString();
  switch (row.workspaceProvider) {
    case 'ssh':
      await db
        .update(projects)
        .set({ sshConnectionId: connectionId, updatedAt })
        .where(eq(projects.id, projectId));
      return;
    case 'k8s':
      await db
        .update(projects)
        .set({ k8sConnectionId: connectionId, updatedAt })
        .where(eq(projects.id, projectId));
      return;
    default:
      throw new Error(
        `Project ${projectId} has workspace provider '${row.workspaceProvider}', which does not support remote connections`
      );
  }
}
