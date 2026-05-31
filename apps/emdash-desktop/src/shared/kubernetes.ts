import type { ConnectionState, SshHealthState } from '@shared/core/ssh/ssh';

/**
 * Kubernetes Connection Configuration
 * Used for storing Kubernetes connection settings
 */
export interface K8sConfig {
  id: string;
  name: string;
  context: string;
  namespace: string;
  podName: string;
  containerName?: string;
  kubeconfigPath?: string;
  /** When set, run agent/terminal sessions inside tmux so they survive exec-stream
   *  reconnects. Defaults ON for Kubernetes connections when unset. */
  tmux?: boolean;
  /** Default terminal shell for this pod. Defaults to '/bin/sh' when unset. */
  shell?: 'sh' | 'bash' | 'zsh';
}

/**
 * Health State
 * Reuses the transport-neutral SSH health state enum.
 */
export type K8sHealthState = SshHealthState;

/**
 * Kubernetes Connection with metadata
 * Extends K8sConfig with runtime connection information
 */
export interface K8sConnection extends K8sConfig {
  id: string;
  state: ConnectionState;
  lastError?: string;
  connectedAt?: Date;
}

export type K8sConnectionUsage = Record<string, Array<{ id: string; name: string }>>;

/**
 * A local (desktop) file or directory entry, used by the kubeconfig path picker
 * so the renderer can browse the user's machine for a kubeconfig file.
 */
export interface LocalPathEntry {
  name: string;
  /** Absolute, ~-expanded path to the entry. */
  path: string;
  type: 'dir' | 'file';
}

/**
 * Result of browsing a local directory for the kubeconfig path picker.
 */
export interface LocalPathListing {
  /** The directory that was listed (absolute, ~-expanded). */
  dir: string;
  entries: LocalPathEntry[];
}

/**
 * Command execution result
 * Returned after executing a command in a pod
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * File entry for in-pod filesystem operations
 * Represents a file or directory inside a pod
 */
export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: Date;
  permissions?: string;
}

/**
 * Test connection result
 * Returned when testing a Kubernetes connection
 */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  latency?: number;
  serverVersion?: string;
  debugLogs?: string[];
}

/**
 * IPC channel names for Kubernetes operations
 * Using 'as const' ensures type safety and prevents typos
 */
export const K8S_IPC_CHANNELS = {
  TEST_CONNECTION: 'k8s:testConnection',
  SAVE_CONNECTION: 'k8s:saveConnection',
  GET_CONNECTIONS: 'k8s:getConnections',
  DELETE_CONNECTION: 'k8s:deleteConnection',
  CONNECT: 'k8s:connect',
  DISCONNECT: 'k8s:disconnect',
  EXECUTE_COMMAND: 'k8s:executeCommand',
  LIST_FILES: 'k8s:listFiles',
  READ_FILE: 'k8s:readFile',
  WRITE_FILE: 'k8s:writeFile',
  GET_STATE: 'k8s:getState',
  ON_STATE_CHANGE: 'k8s:onStateChange',
  LIST_CONTEXTS: 'k8s:listContexts',
  LIST_NAMESPACES: 'k8s:listNamespaces',
  LIST_PODS: 'k8s:listPods',
  CHECK_IS_GIT_REPO: 'k8s:checkIsGitRepo',
  INIT_REPO: 'k8s:initRepo',
  CLONE_REPO: 'k8s:cloneRepo',
} as const;

/**
 * Type for Kubernetes IPC channel names
 * Can be used for type-safe IPC handlers
 */
export type K8sIpcChannel = (typeof K8S_IPC_CHANNELS)[keyof typeof K8S_IPC_CHANNELS];

/**
 * Kubernetes context entry parsed from kubeconfig
 */
export interface K8sConfigContext {
  name: string;
  cluster?: string;
  user?: string;
  namespace?: string;
}
