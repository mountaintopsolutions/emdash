import type {
  CreateProjectParams,
  CreateProjectResult,
  InspectProjectPathParams,
  ProjectPathInspection,
} from '@shared/projects';
import { createK8sProject, getK8sProjectPathStatus } from './create-k8s-project';
import { createLocalProject, getLocalProjectPathStatus } from './create-local-project';
import { createSshProject, getSshProjectPathStatus } from './create-ssh-project';
import { getK8sProjectByPath, getLocalProjectByPath, getSshProjectByPath } from './getProjects';

export async function createProject(params: CreateProjectParams): Promise<CreateProjectResult> {
  if (params.type === 'local') {
    const { type: _type, ...localParams } = params;
    return createLocalProject(localParams);
  }

  if (params.type === 'k8s') {
    const { type: _type, ...k8sParams } = params;
    return createK8sProject(k8sParams);
  }

  const { type: _type, ...sshParams } = params;
  return createSshProject(sshParams);
}

export async function inspectProjectPath(
  params: InspectProjectPathParams
): Promise<ProjectPathInspection> {
  if (params.type === 'local') {
    const [status, existingProject] = await Promise.all([
      getLocalProjectPathStatus(params.path),
      getLocalProjectByPath(params.path),
    ]);
    return { ...status, existingProject };
  }

  if (params.type === 'k8s') {
    const [status, existingProject] = await Promise.all([
      getK8sProjectPathStatus(params.path, params.connectionId),
      getK8sProjectByPath(params.path, params.connectionId),
    ]);
    return { ...status, existingProject };
  }

  const [status, existingProject] = await Promise.all([
    getSshProjectPathStatus(params.path, params.connectionId),
    getSshProjectByPath(params.path, params.connectionId),
  ]);
  return { ...status, existingProject };
}
