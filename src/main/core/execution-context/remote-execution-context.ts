import { eq } from 'drizzle-orm';
import { K8sFileSystem } from '@main/core/fs/impl/k8s-fs';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { FileSystemProvider } from '@main/core/fs/types';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { db } from '@main/db/client';
import { k8sConnections } from '@main/db/schema';
import { K8sExecutionContext } from './k8s-execution-context';
import { SshExecutionContext } from './ssh-execution-context';
import type { IExecutionContext } from './types';

/**
 * True when the connection id belongs to a Kubernetes connection. The k8s and
 * ssh connection id-spaces are disjoint tables, so a single lookup disambiguates
 * a saved connection id without needing the caller to know the transport.
 */
export async function isK8sConnection(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: k8sConnections.id })
    .from(k8sConnections)
    .where(eq(k8sConnections.id, connectionId))
    .limit(1);
  return row !== undefined;
}

/**
 * Build a remote execution context + filesystem for a saved connection id,
 * dispatching to the correct transport (Kubernetes vs SSH). `root` is the POSIX
 * working directory both will be rooted at.
 */
export async function createRemoteExecutionContextAndFs(
  connectionId: string,
  root: string
): Promise<{ ctx: IExecutionContext; fs: FileSystemProvider }> {
  if (await isK8sConnection(connectionId)) {
    const proxy = await kubeConnectionManager.connect(connectionId);
    return { ctx: new K8sExecutionContext(proxy, { root }), fs: new K8sFileSystem(proxy, root) };
  }
  const proxy = await sshConnectionManager.connect(connectionId);
  return { ctx: new SshExecutionContext(proxy, { root }), fs: new SshFileSystem(proxy, root) };
}
