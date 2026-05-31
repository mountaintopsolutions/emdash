import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { k8sConnections } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { k8sConnectionEventChannel } from '@shared/events/k8sEvents';
import { resolveProductionKubeConnectConfig } from '../connect/production-connect-config';
import { KubeConnectionManager } from './kube-connection-manager';

export const kubeConnectionManager = new KubeConnectionManager({
  loadConnectionRow: async (id) => {
    const [row] = await db.select().from(k8sConnections).where(eq(k8sConnections.id, id)).limit(1);
    return row;
  },
  resolveConnectConfig: async (row) =>
    await resolveProductionKubeConnectConfig({ kind: 'persisted', row }),
  publishEvent: (event) => events.emit(k8sConnectionEventChannel, event),
  log,
});
