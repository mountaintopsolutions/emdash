import { BoxesIcon, PlusIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import type { K8sConfig, K8sConnectionUsage } from '@shared/kubernetes';
import { K8sConnectionRow } from './K8sConnectionRow';

export const K8sConnectionsSettingsCard = observer(function K8sConnectionsSettingsCard() {
  const [usage, setUsage] = useState<K8sConnectionUsage>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const showK8sConnModal = useShowModal('addK8sConnModal');
  const showConfirm = useShowModal('confirmActionModal');

  const connections = [...appState.k8sConnections.connections].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const refreshUsage = useCallback(async (): Promise<K8sConnectionUsage | null> => {
    try {
      const nextUsage = await rpc.k8s.getConnectionUsage();
      setUsage(nextUsage);
      return nextUsage;
    } catch (error) {
      toast({
        title: 'Failed to load Kubernetes connection usage',
        description: String(error),
        variant: 'destructive',
      });
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [connections.length, refreshUsage]);

  const openAddModal = () => {
    showK8sConnModal({
      dismissControl: 'close',
      onSuccess: () => {
        void refreshUsage();
      },
    });
  };

  const openEditModal = (connection: K8sConfig) => {
    showK8sConnModal({
      dismissControl: 'close',
      initialConfig: connection,
      onSuccess: () => {
        void refreshUsage();
      },
    });
  };

  const deleteConnection = async (connection: K8sConfig) => {
    setDeletingId(connection.id);
    try {
      await appState.k8sConnections.deleteConnection(connection.id);
      await refreshUsage();
    } catch (error) {
      toast({
        title: 'Failed to delete Kubernetes connection',
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const requestDelete = async (connection: K8sConfig) => {
    setDeletingId(connection.id);
    const latestUsage = await refreshUsage();
    setDeletingId(null);

    if (!latestUsage) return;

    const projects = latestUsage[connection.id] ?? [];
    if (projects.length > 0) {
      showConfirm({
        title: 'Cannot delete Kubernetes connection',
        description:
          'This Kubernetes connection is still used by at least one project. Change those projects to another connection before deleting it.',
        confirmLabel: 'Close',
      });
      return;
    }

    showConfirm({
      title: 'Delete Kubernetes connection',
      description: `This will remove "${connection.name}" and its saved credentials from this device.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
      onSuccess: () => {
        void deleteConnection(connection);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-normal text-foreground">Kubernetes connections</h3>
          <p className="text-xs text-foreground-passive">Reusable pods for Kubernetes projects.</p>
        </div>
        <Button type="button" variant="ghost" onClick={openAddModal}>
          <PlusIcon className="size-4" />
          Add
        </Button>
      </div>

      {connections.length === 0 ? (
        <div className="bg-muted/10 flex min-h-48 flex-col items-center justify-center rounded-lg border border-border p-8 text-center">
          <BoxesIcon className="mb-3 size-8 text-foreground-passive" />
          <div className="text-sm text-foreground">No Kubernetes connections</div>
          <p className="mt-1 max-w-sm text-xs text-foreground-passive">
            Add a connection to create and manage projects inside a pod.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((connection) => {
            const projects = usage[connection.id] ?? [];
            const isDeleting = deletingId === connection.id;

            return (
              <K8sConnectionRow
                key={connection.id}
                connection={connection}
                projects={projects}
                isDeleting={isDeleting}
                onEdit={openEditModal}
                onDelete={requestDelete}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});
