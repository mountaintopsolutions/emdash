import crypto from 'node:crypto';

export function computeWorkspaceKey(
  type: 'local' | 'project-ssh' | 'project-k8s',
  absolutePath: string,
  connectionId?: string
): string {
  const input =
    type === 'project-ssh' && connectionId
      ? `ssh:${connectionId}:${absolutePath}`
      : type === 'project-k8s' && connectionId
        ? `k8s:${connectionId}:${absolutePath}`
        : `local:${absolutePath}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}
