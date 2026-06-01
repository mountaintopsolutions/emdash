import { VersionApi } from '@kubernetes/client-node';
import type { ConnectionTestResult, K8sConfig } from '@shared/kubernetes';
import { KubeClientProxy } from '../lifecycle/kube-client-proxy';
import { verifyPodRunning as defaultVerifyPodRunning } from '../lifecycle/kube-connection-manager';
import type { KubeConnectResult, TransientConnectInput } from './resolve-kube-connect-config';

export interface TestK8sConnectionDeps {
  resolve: (input: TransientConnectInput) => Promise<KubeConnectResult>;
  verifyPodRunning: (resolved: KubeConnectResult) => Promise<void>;
  /** Optional server-version probe; cheap and best-effort. */
  getServerVersion?: (resolved: KubeConnectResult) => Promise<string | undefined>;
}

async function defaultGetServerVersion(resolved: KubeConnectResult): Promise<string | undefined> {
  try {
    const version = await resolved.kc.makeApiClient(VersionApi).getCode();
    return version.gitVersion;
  } catch {
    return undefined;
  }
}

const defaultDeps: Omit<TestK8sConnectionDeps, 'resolve'> = {
  verifyPodRunning: defaultVerifyPodRunning,
  getServerVersion: defaultGetServerVersion,
};

/**
 * Tests a Kubernetes connection end to end: resolve the config, confirm the pod
 * is Running, run a trivial in-pod command, and measure round-trip latency.
 * Mirrors testSshConnection. Never throws — failures are returned as a result.
 */
export async function testK8sConnection(
  config: K8sConfig & { token?: string },
  deps: Partial<TestK8sConnectionDeps> = {}
): Promise<ConnectionTestResult> {
  if (!deps.resolve) {
    throw new Error('Kubernetes connect resolver dependency was not provided');
  }
  const mergedDeps: TestK8sConnectionDeps = { ...defaultDeps, ...deps, resolve: deps.resolve };
  const startTime = Date.now();
  const debugLogs: string[] = [];

  let resolved: KubeConnectResult;
  try {
    resolved = await mergedDeps.resolve({ kind: 'transient', config });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      debugLogs,
    };
  }

  try {
    await mergedDeps.verifyPodRunning(resolved);

    const proxy = new KubeClientProxy(config.id);
    proxy.update(resolved.kc, resolved.target);
    const result = await proxy.exec('true');
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `Probe command exited with code ${result.exitCode}`,
        debugLogs,
      };
    }

    const serverVersion = await mergedDeps.getServerVersion?.(resolved);
    const latency = Date.now() - startTime;
    return { success: true, latency, serverVersion, debugLogs };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      debugLogs,
    };
  } finally {
    resolved.cleanup();
  }
}
