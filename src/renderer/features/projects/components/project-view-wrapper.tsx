import type { ReactNode } from 'react';
import { ProjectK8sHealthGate } from './project-k8s-health-gate';
import { ProjectSshHealthGate } from './project-ssh-health-gate';

interface ProjectViewWrapperProps {
  children: ReactNode;
  projectId: string;
}

export function ProjectViewWrapper({ children, projectId }: ProjectViewWrapperProps) {
  return (
    <ProjectSshHealthGate projectId={projectId}>
      <ProjectK8sHealthGate projectId={projectId}>{children}</ProjectK8sHealthGate>
    </ProjectSshHealthGate>
  );
}
