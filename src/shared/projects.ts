export type ProjectPathStatus = {
  isDirectory: boolean;
  isGitRepo: boolean;
};

export type LocalProject = {
  type: 'local';
  id: string;
  name: string;
  path: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
};

export type SshProject = {
  type: 'ssh';
  id: string;
  name: string;
  path: string;
  baseRef: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
};

export type K8sProject = {
  type: 'k8s';
  id: string;
  name: string;
  path: string;
  baseRef: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
};

export type Project = LocalProject | SshProject | K8sProject;

export type CreateLocalProjectParams = {
  type: 'local';
  id?: string;
  path: string;
  name: string;
  initGitRepository?: boolean;
};

export type CreateSshProjectParams = {
  type: 'ssh';
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export type CreateK8sProjectParams = {
  type: 'k8s';
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export type CreateProjectParams =
  | CreateLocalProjectParams
  | CreateSshProjectParams
  | CreateK8sProjectParams;

export type InspectLocalProjectPathParams = {
  type: 'local';
  path: string;
};

export type InspectSshProjectPathParams = {
  type: 'ssh';
  path: string;
  connectionId: string;
};

export type InspectK8sProjectPathParams = {
  type: 'k8s';
  path: string;
  connectionId: string;
};

export type InspectProjectPathParams =
  | InspectLocalProjectPathParams
  | InspectSshProjectPathParams
  | InspectK8sProjectPathParams;

export type ProjectPathInspection = ProjectPathStatus & {
  existingProject?: Project;
};

export type OpenProjectError =
  | { type: 'path-not-found'; path: string }
  | { type: 'ssh-disconnected'; connectionId: string }
  | { type: 'pod-not-running'; connectionId: string }
  | { type: 'pod-gone'; connectionId: string }
  | { type: 'error'; message: string };

export type UpdateProjectSettingsError =
  | { type: 'project-not-found' }
  | { type: 'invalid-settings' }
  | { type: 'invalid-worktree-directory' }
  | { type: 'write-config-failed'; message: string }
  | { type: 'error' };

export type ProjectRemoteState = {
  hasRemote: boolean;
  selectedRemoteUrl: string | null;
};
