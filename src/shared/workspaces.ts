export type WorkspaceType = 'local' | 'project-ssh' | 'project-k8s' | 'byoi';

export type WorkspaceResolution =
  | { kind: 'ready' }
  | { kind: 'needs_create' }
  | { kind: 'branch_elsewhere'; taskBranch: string; candidatePath: string; previousPath: string }
  | { kind: 'path_missing'; previousPath: string; taskBranch: string | null };
