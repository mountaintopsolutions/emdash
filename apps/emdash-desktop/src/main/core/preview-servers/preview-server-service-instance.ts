import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { events } from '@main/lib/events';
import { previewServerEventChannel } from '@shared/core/preview-servers/events';
import { PortForwardService } from '../port-forwards/port-forward-service';
import { PreviewServerService } from './preview-server-service';

export const previewServerService = new PreviewServerService({
  portForwards: new PortForwardService(),
  emit: (event) => events.emit(previewServerEventChannel, event),
  getConnectionState: (connectionId) => sshConnectionManager.getConnectionState(connectionId),
  getSshProxy: async (connectionId) => await sshConnectionManager.connect(connectionId),
  getK8sConnectionState: (connectionId) => kubeConnectionManager.getConnectionState(connectionId),
  getK8sProxy: async (connectionId) => await kubeConnectionManager.connect(connectionId),
  // Periodically reconcile forwarded preview statuses against live connection
  // state so a dropped port-forward flips to 'reconnecting' even if its
  // connection event was missed.
  healthCheckIntervalMs: 10_000,
});

sshConnectionManager.on('connection-event', (event) => {
  previewServerService.handleSshConnectionEvent(event);
});

kubeConnectionManager.on('connection-event', (event) => {
  previewServerService.handleK8sConnectionEvent(event);
});
