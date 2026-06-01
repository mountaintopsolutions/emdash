import { defineEvent } from '@shared/ipc/events';
import type { K8sHealthState } from '@shared/kubernetes';

export type K8sConnectionEvent =
  | { type: 'connecting'; connectionId: string }
  | { type: 'connected'; connectionId: string }
  | { type: 'disconnected'; connectionId: string }
  | { type: 'reconnecting'; connectionId: string; attempt: number; delayMs: number }
  | { type: 'reconnected'; connectionId: string }
  | { type: 'reconnect-failed'; connectionId: string }
  | { type: 'error'; connectionId: string; errorMessage: string }
  | { type: 'health-changed'; connectionId: string; health: K8sHealthState };

export const k8sConnectionEventChannel = defineEvent<K8sConnectionEvent>('k8s:connection-event');
