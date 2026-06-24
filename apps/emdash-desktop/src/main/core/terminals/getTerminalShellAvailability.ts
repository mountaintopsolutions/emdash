import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import {
  getLocalTerminalShellAvailability,
  getRemoteTerminalShellAvailability,
} from '@main/core/terminal-shell/resolver';

export async function getTerminalShellAvailability(
  target?:
    | {
        kind: 'local';
      }
    | {
        kind: 'ssh';
        connectionId: string;
      }
    | {
        kind: 'k8s';
        connectionId: string;
      }
) {
  if (!target || target.kind === 'local') return await getLocalTerminalShellAvailability();
  const proxy =
    target.kind === 'k8s'
      ? await kubeConnectionManager.connect(target.connectionId)
      : await sshConnectionManager.connect(target.connectionId);
  const profile = await proxy.getRemoteShellProfile();
  return await getRemoteTerminalShellAvailability(proxy, profile);
}
