import type { ConnectionTestResult, K8sConfig } from '@shared/kubernetes';
import { resolveProductionKubeConnectConfig } from './production-connect-config';
import { testK8sConnection } from './test-connection';

export async function testProductionK8sConnection(
  config: K8sConfig & { token?: string }
): Promise<ConnectionTestResult> {
  return await testK8sConnection(config, {
    resolve: (input) => resolveProductionKubeConnectConfig(input),
  });
}
