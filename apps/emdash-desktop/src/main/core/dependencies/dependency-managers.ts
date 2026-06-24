import type { Platform } from '@emdash/core/deps';
import {
  HostDependencyManager,
  type DependencyId,
  type DependencyProbeOptions,
} from '@emdash/core/deps/runtime';
import { eq } from 'drizzle-orm';
import { clearResolvedPathCache } from '@main/core/conversations/impl/resolve-agent-executable';
import { K8sExecutionContext } from '@main/core/execution-context/k8s-execution-context';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { kubeConnectionManager } from '@main/core/k8s/lifecycle/production-kube-connection-manager';
import { appSettingsService } from '@main/core/settings/settings-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import { db } from '@main/db/client';
import { k8sConnections } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { agentUpdateService } from './agent-update-service';
import { hostDependencyStore } from './host-dependency-store';
import {
  createK8sInstallCommandRunner,
  createLocalInstallCommandRunner,
  createSshInstallCommandRunner,
} from './install-runner';
import { DEPENDENCIES, AGENT_DEPENDENCIES, getDependencyDescriptor } from './registry';

async function resolveLocalInstallShellProfile() {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: defaultShell,
    onFallback: (error) => {
      log.warn('[DependencyManager] Preferred install shell unavailable, using fallback', {
        shell: error.shell,
        target: error.target,
      });
    },
  });
}

function wireDesktopBridges(manager: HostDependencyManager, connectionId?: string): void {
  // AgentUpdateService owns the enriched event emission (adds latestVersion/updateAvailable)
  agentUpdateService.attach(manager, connectionId);
  manager.onExecutableInvalidated.subscribe(({ id }: { id: DependencyId }) => {
    clearResolvedPathCache(id, connectionId);
  });
}

export const localDependencyManager = new HostDependencyManager(new LocalExecutionContext(), {
  runInstallCommand: createLocalInstallCommandRunner(resolveLocalInstallShellProfile),
  getSelection: (depId) => hostDependencyStore.getSelection('local', depId),
  logger: log,
  dependencies: DEPENDENCIES,
  getDependencyDescriptor,
});
wireDesktopBridges(localDependencyManager, undefined);

const sshManagers = new Map<string, HostDependencyManager>();
const k8sManagers = new Map<string, HostDependencyManager>();
const managerPromises = new Map<string, Promise<HostDependencyManager>>();
const agentProbePromises = new WeakMap<HostDependencyManager, Promise<void>>();

/** Resolve the OS platform of a remote machine via a lightweight `uname -s` probe. */
async function resolveRemotePlatform(ctx: IExecutionContext): Promise<Platform> {
  try {
    const { stdout } = await ctx.exec('uname', ['-s'], { timeout: 5000 });
    const os = stdout.trim().toLowerCase();
    if (os === 'darwin') return 'macos';
    return 'linux';
  } catch {
    return 'linux';
  }
}

async function isK8sConnection(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: k8sConnections.id })
    .from(k8sConnections)
    .where(eq(k8sConnections.id, connectionId))
    .limit(1);
  return row !== undefined;
}

async function getK8sDependencyManager(connectionId: string): Promise<HostDependencyManager> {
  let mgr = k8sManagers.get(connectionId);
  if (!mgr) {
    const proxy = await kubeConnectionManager.connect(connectionId);
    const k8sCtx = new K8sExecutionContext(proxy);
    const platform = await resolveRemotePlatform(k8sCtx);
    mgr = new HostDependencyManager(k8sCtx, {
      runInstallCommand: createK8sInstallCommandRunner(proxy),
      connectionId,
      platform,
      getSelection: (depId) => hostDependencyStore.getSelection(connectionId, depId),
      logger: log,
      dependencies: DEPENDENCIES,
      getDependencyDescriptor,
    });
    wireDesktopBridges(mgr, connectionId);
    k8sManagers.set(connectionId, mgr);
  }
  return mgr;
}

async function getSshDependencyManager(connectionId: string): Promise<HostDependencyManager> {
  let mgr = sshManagers.get(connectionId);
  if (!mgr) {
    const proxy = await sshConnectionManager.connect(connectionId);
    const sshCtx = new SshExecutionContext(proxy);
    const platform = await resolveRemotePlatform(sshCtx);
    mgr = new HostDependencyManager(sshCtx, {
      runInstallCommand: createSshInstallCommandRunner(proxy),
      connectionId,
      platform,
      getSelection: (depId) => hostDependencyStore.getSelection(connectionId, depId),
      logger: log,
      dependencies: DEPENDENCIES,
      getDependencyDescriptor,
    });
    wireDesktopBridges(mgr, connectionId);
    sshManagers.set(connectionId, mgr);
  }
  return mgr;
}

export async function getDependencyManager(connectionId?: string): Promise<HostDependencyManager> {
  if (!connectionId) return localDependencyManager;
  // Fast path: a manager built for this id is already transport-correct, so
  // skip the connection-type DB lookup entirely.
  const existing = k8sManagers.get(connectionId) ?? sshManagers.get(connectionId);
  if (existing) return existing;

  const pending = managerPromises.get(connectionId);
  if (pending) return pending;

  // The k8s and ssh connection id-spaces are disjoint tables, so look up k8s
  // first: a hit means this is a k8s project, otherwise fall back to SSH.
  const promise = (async () =>
    (await isK8sConnection(connectionId))
      ? getK8sDependencyManager(connectionId)
      : getSshDependencyManager(connectionId))().finally(() => {
    if (managerPromises.get(connectionId) === promise) managerPromises.delete(connectionId);
  });
  managerPromises.set(connectionId, promise);
  return promise;
}

export function clearDependencyManager(connectionId: string): void {
  sshManagers.delete(connectionId);
  k8sManagers.delete(connectionId);
  managerPromises.delete(connectionId);
}

export async function ensureAgentDependenciesProbed(
  manager: HostDependencyManager,
  options: DependencyProbeOptions = { refreshShellEnv: true }
): Promise<void> {
  if (AGENT_DEPENDENCIES.every((dependency) => manager.get(dependency.id) !== undefined)) return;

  const existing = agentProbePromises.get(manager);
  if (existing) {
    await existing;
    return;
  }

  const promise = manager.probeCategory('agent', options).finally(() => {
    agentProbePromises.delete(manager);
  });
  agentProbePromises.set(manager, promise);
  await promise;
}
