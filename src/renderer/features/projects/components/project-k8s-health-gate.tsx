import { observer } from 'mobx-react-lite';
import { type ReactNode } from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { getProjectStore } from '../stores/project-selectors';
import { K8sPodUnavailablePanel } from './k8s-pod-unavailable-panel';

export const ProjectK8sHealthGate = observer(function ProjectK8sHealthGate({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  const data = getProjectStore(projectId)?.data;
  const k8sConnectionId = data?.type === 'k8s' ? data.connectionId : undefined;
  const k8sHealth = k8sConnectionId ? appState.k8sConnections.healthFor(k8sConnectionId) : null;

  if (k8sConnectionId && k8sHealth?.status === 'degraded') {
    return <K8sPodUnavailablePanel connectionId={k8sConnectionId} />;
  }

  return <>{children}</>;
});
