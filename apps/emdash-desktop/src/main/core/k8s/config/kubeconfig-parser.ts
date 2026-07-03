// Best-effort loading of kubeconfig contexts/namespaces/pods for UI pickers.
// Not canonical for connection behavior — connection resolution happens in
// resolve-kube-connect-config.ts via a fully constructed KubeConfig.
import { statSync } from 'node:fs';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { K8sConfigContext } from '@shared/kubernetes';
import { expandTilde } from './local-path-browser';

/**
 * A pod entry suitable for selection UI.
 */
export interface K8sPodEntry {
  name: string;
  namespace: string;
  phase: string;
  containers: string[];
}

/** Discovery calls hit the API server; bound them so a hang surfaces as an error. */
const DISCOVERY_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s ${what}`)),
      DISCOVERY_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Loads a KubeConfig from the given path, or from the default discovery chain
 * (KUBECONFIG env / ~/.kube/config) when no path is provided.
 */
export function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) {
    // loadFromFile does not expand `~`, so a path like `~/.kube/config` would
    // fail on macOS/Linux without expanding it first.
    const resolved = expandTilde(kubeconfigPath);
    // Surface a clear, recoverable error instead of a raw EISDIR/ENOENT — a
    // common mistake is pointing at the `~/.kube` directory rather than the
    // `config` file inside it.
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(resolved);
    } catch {
      throw new Error(`Kubeconfig not found at ${resolved}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`Kubeconfig path ${resolved} is a directory — point to the config file`);
    }
    kc.loadFromFile(resolved);
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

/**
 * Enumerates the contexts defined in a kubeconfig. Mirrors parseSshConfigFile,
 * returning a best-effort list for import/selection UI.
 */
export function parseKubeConfigContexts(kc: KubeConfig): K8sConfigContext[] {
  return kc.getContexts().map((context) => ({
    name: context.name,
    cluster: context.cluster,
    user: context.user,
    namespace: context.namespace,
  }));
}

/**
 * Convenience wrapper: load a kubeconfig and return its contexts.
 */
export function listKubeConfigContexts(kubeconfigPath?: string): K8sConfigContext[] {
  return parseKubeConfigContexts(loadKubeConfig(kubeconfigPath));
}

/**
 * Resolves a kubeconfig to a specific context, returning a fresh KubeConfig with
 * that context selected as current. Throws if the context does not exist.
 */
export function resolveKubeContext(kc: KubeConfig, context: string): KubeConfig {
  const exists = kc.getContexts().some((entry) => entry.name === context);
  if (!exists) {
    throw new Error(`Kubernetes context '${context}' not found in kubeconfig`);
  }
  kc.setCurrentContext(context);
  return kc;
}

function coreApiForContext(kubeconfigPath: string | undefined, context: string): CoreV1Api {
  const kc = resolveKubeContext(loadKubeConfig(kubeconfigPath), context);
  return kc.makeApiClient(CoreV1Api);
}

/**
 * Lists namespace names visible to the given context. Mirrors the best-effort
 * listing approach used for SSH config hosts.
 */
export async function listNamespacesForContext(
  context: string,
  kubeconfigPath?: string
): Promise<string[]> {
  const core = coreApiForContext(kubeconfigPath, context);
  const list = await withTimeout(core.listNamespace(), 'listing namespaces');
  return (list.items ?? [])
    .map((item) => item.metadata?.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

/**
 * Lists pods in a namespace for the given context, including their phase and
 * container names so callers can drive a pod/container picker.
 */
export async function listPodsForContext(
  context: string,
  namespace: string,
  kubeconfigPath?: string
): Promise<K8sPodEntry[]> {
  const core = coreApiForContext(kubeconfigPath, context);
  const list = await withTimeout(core.listNamespacedPod({ namespace }), 'listing pods');
  return (list.items ?? [])
    .map((pod) => {
      const name = pod.metadata?.name;
      if (!name) return undefined;
      return {
        name,
        namespace: pod.metadata?.namespace ?? namespace,
        phase: pod.status?.phase ?? 'Unknown',
        containers: (pod.spec?.containers ?? [])
          .map((container) => container.name)
          .filter((containerName): containerName is string => Boolean(containerName)),
      } satisfies K8sPodEntry;
    })
    .filter((entry): entry is K8sPodEntry => entry !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}
