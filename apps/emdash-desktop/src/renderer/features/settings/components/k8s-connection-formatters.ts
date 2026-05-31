import type { ConnectionState } from '@shared/core/ssh/ssh';
import type { K8sConfig } from '@shared/kubernetes';

export function targetLabel(connection: K8sConfig): string {
  const base = `${connection.context}/${connection.namespace}/${connection.podName}`;
  return connection.containerName ? `${base} (${connection.containerName})` : base;
}

export function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'error':
      return 'Error';
    case 'disconnected':
      return 'Disconnected';
  }
}

export function projectUsageText(projects: Array<{ id: string; name: string }>): string {
  if (projects.length === 0) return 'No projects';
  if (projects.length === 1) return projects[0].name;
  return `${projects.length} projects`;
}

export function projectUsageNamesText(
  projects: Array<{ id: string; name: string }>,
  visibleCount = 3
): string | null {
  if (projects.length <= 1) return null;

  const visibleProjects = projects.slice(0, visibleCount);
  const remainingCount = projects.length - visibleProjects.length;
  const visibleNames = visibleProjects.map((project) => project.name).join(', ');

  if (remainingCount === 0) return visibleNames;
  return `${visibleNames}, +${remainingCount} more`;
}
