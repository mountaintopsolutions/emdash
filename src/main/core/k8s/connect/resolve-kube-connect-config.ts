import type { KubeConfig } from '@kubernetes/client-node';
import type { K8sConnectionRow } from '@main/db/schema';
import type { K8sConfig } from '@shared/kubernetes';
import { k8sConfigFromRow } from '../config/connection-metadata';
import { loadKubeConfig, resolveKubeContext } from '../config/kubeconfig-parser';

/**
 * The pod a connection targets, resolved from the connection config.
 */
export interface KubeTarget {
  namespace: string;
  podName: string;
  containerName?: string;
}

/**
 * Result of resolving a connection into a ready-to-use KubeConfig + target.
 * Mirrors SshConnectResult (config + cleanup + debugLogs).
 */
export interface KubeConnectResult {
  kc: KubeConfig;
  target: KubeTarget;
  context: string;
  cleanup: () => void;
  debugLogs: string[];
}

export type PersistedConnectInput = { kind: 'persisted'; row: K8sConnectionRow };
export type TransientConnectInput = {
  kind: 'transient';
  config: K8sConfig & { token?: string };
};
export type KubeConnectInput = PersistedConnectInput | TransientConnectInput;

export interface KubeConnectDeps {
  /** Loads a KubeConfig from a path (or the default chain when undefined). */
  loadKubeConfig: (kubeconfigPath?: string) => KubeConfig;
  /** Fetches a stored bearer token for a persisted connection, if any. */
  getToken: (connectionId: string) => Promise<string | null>;
}

function defaultDeps(): KubeConnectDeps {
  return {
    loadKubeConfig,
    getToken: async () => null,
  };
}

function baseConfigForInput(input: KubeConnectInput): K8sConfig {
  return input.kind === 'persisted' ? k8sConfigFromRow(input.row) : input.config;
}

/**
 * Applies a bearer token to the kubeconfig's current-context user so that
 * subsequent API/exec calls authenticate with the supplied token. A no-op when
 * the token is empty.
 */
function applyToken(kc: KubeConfig, token: string | null | undefined): void {
  if (!token) return;
  const currentContext = kc.getContextObject(kc.getCurrentContext());
  const userName = currentContext?.user;
  if (!userName) return;
  const user = kc.getUser(userName);
  if (!user) return;
  // Mutate the resolved user in place so subsequent API/exec calls authenticate
  // with the supplied bearer token, clearing any conflicting credential fields.
  const mutableUser = user as {
    token?: string;
    authProvider?: unknown;
    exec?: unknown;
  };
  mutableUser.token = token;
  mutableUser.authProvider = undefined;
  mutableUser.exec = undefined;
}

export async function resolveKubeConnectConfig(
  input: KubeConnectInput,
  depsOverride: Partial<KubeConnectDeps> = {}
): Promise<KubeConnectResult> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const base = baseConfigForInput(input);

  const kc = deps.loadKubeConfig(base.kubeconfigPath);
  resolveKubeContext(kc, base.context);

  const token = input.kind === 'transient' ? input.config.token : await deps.getToken(base.id);
  applyToken(kc, token);

  const target: KubeTarget = {
    namespace: base.namespace,
    podName: base.podName,
    containerName: base.containerName,
  };

  return {
    kc,
    target,
    context: base.context,
    cleanup: () => {},
    debugLogs: [],
  };
}

export function createKubeConnectConfigResolver(deps: KubeConnectDeps) {
  return async (input: KubeConnectInput): Promise<KubeConnectResult> =>
    await resolveKubeConnectConfig(input, deps);
}
