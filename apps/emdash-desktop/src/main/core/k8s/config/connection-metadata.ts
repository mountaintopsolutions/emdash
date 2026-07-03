// DB metadata column serialization for Kubernetes connections.
import type { K8sConnectionRow } from '@main/db/schema';
import type { K8sConfig } from '@shared/kubernetes';

type K8sShell = 'sh' | 'bash' | 'zsh';

export interface K8sConnectionMetadata {
  kubeconfigPath?: string;
  tmux?: boolean;
  shell?: K8sShell;
}

type K8sConnectionMetadataUpdate = {
  kubeconfigPath?: string | undefined;
  tmux?: boolean | undefined;
  shell?: K8sShell | undefined;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalShell(value: unknown): K8sShell | undefined {
  return value === 'sh' || value === 'bash' || value === 'zsh' ? value : undefined;
}

export function parseK8sConnectionMetadata(metadata: string | null): K8sConnectionMetadata {
  if (!metadata) return {};

  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const result: K8sConnectionMetadata = {};
    const kubeconfigPath = optionalString(parsed.kubeconfigPath);
    if (kubeconfigPath) result.kubeconfigPath = kubeconfigPath;
    const tmux = optionalBoolean(parsed.tmux);
    if (tmux !== undefined) result.tmux = tmux;
    const shell = optionalShell(parsed.shell);
    if (shell !== undefined) result.shell = shell;
    return result;
  } catch {
    return {};
  }
}

export function serializeK8sConnectionMetadata(metadata: K8sConnectionMetadata): string {
  return JSON.stringify({
    kubeconfigPath: optionalString(metadata.kubeconfigPath),
    tmux: optionalBoolean(metadata.tmux),
    shell: optionalShell(metadata.shell),
  });
}

export function mergeK8sConnectionMetadata(
  existing: K8sConnectionMetadata,
  update: K8sConnectionMetadataUpdate
): K8sConnectionMetadata {
  const has = (key: keyof K8sConnectionMetadataUpdate) =>
    Object.prototype.hasOwnProperty.call(update, key);

  return {
    kubeconfigPath: has('kubeconfigPath')
      ? optionalString(update.kubeconfigPath)
      : existing.kubeconfigPath,
    tmux: has('tmux') ? optionalBoolean(update.tmux) : existing.tmux,
    shell: has('shell') ? optionalShell(update.shell) : existing.shell,
  };
}

export function k8sConfigFromRow(row: K8sConnectionRow): K8sConfig {
  const metadata = parseK8sConnectionMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    context: row.context,
    namespace: row.namespace,
    podName: row.podName,
    containerName: row.containerName ?? undefined,
    kubeconfigPath: row.kubeconfigPath ?? metadata.kubeconfigPath,
    tmux: metadata.tmux,
    shell: metadata.shell,
  };
}
