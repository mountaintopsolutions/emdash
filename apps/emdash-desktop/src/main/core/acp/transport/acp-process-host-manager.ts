import { machineKey, type MachineRef } from '@main/core/runtime/types';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { LegacyK8sAcpProcessHost } from './legacy-k8s-acp-process-host';
import { LegacySshAcpProcessHost } from './legacy-ssh-acp-process-host';
import { LocalAcpProcessHost } from './local-acp-process-host';
import type { AcpProcessHost, AcpProcessHostManager } from './types';

/**
 * Standalone singleton that maps a MachineRef to an AcpProcessHost.
 *
 * - `local` → shared LocalAcpProcessHost instance (spawns node:child_process).
 * - `ssh:<connectionId>` → LegacySshAcpProcessHost built from the live
 *   SshClientProxy returned by sshConnectionManager.connect(connectionId).
 * - `k8s:<connectionId>` → LegacyK8sAcpProcessHost built from the live
 *   KubeClientProxy returned by kubeConnectionManager.connect(connectionId).
 *   Process hosts are cached per connection id for the lifetime of the
 *   manager; the underlying proxy handles reconnects transparently.
 */
class AcpProcessHostManagerImpl implements AcpProcessHostManager {
  private readonly localHost = new LocalAcpProcessHost();
  private readonly remoteHosts = new Map<string, AcpProcessHost>();

  async get(machine: MachineRef): Promise<AcpProcessHost> {
    const key = machineKey(machine);

    if (machine.kind === 'local') {
      return this.localHost;
    }

    const cached = this.remoteHosts.get(key);
    if (cached) return cached;

    const proxy =
      machine.kind === 'k8s'
        ? await kubeConnectionManager.connect(machine.connectionId)
        : await sshConnectionManager.connect(machine.connectionId);

    const host =
      machine.kind === 'k8s'
        ? new LegacyK8sAcpProcessHost(proxy)
        : new LegacySshAcpProcessHost(proxy);
    this.remoteHosts.set(key, host);
    return host;
  }
}

export const acpProcessHostManager: AcpProcessHostManager = new AcpProcessHostManagerImpl();
