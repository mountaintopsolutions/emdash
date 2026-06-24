import { k8sCredentialService } from '@main/core/k8s/credentials/k8s-credential-service';
import { loadKubeConfig } from '../config/kubeconfig-parser';
import {
  createKubeConnectConfigResolver,
  type KubeConnectInput,
  type KubeConnectResult,
} from './resolve-kube-connect-config';

export const resolveProductionKubeConnectConfig = createKubeConnectConfigResolver({
  loadKubeConfig,
  getToken: (connectionId) => k8sCredentialService.getToken(connectionId),
});

export type { KubeConnectInput, KubeConnectResult };
