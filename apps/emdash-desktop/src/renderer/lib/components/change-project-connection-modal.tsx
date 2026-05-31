import { useState } from 'react';
import { K8sConnectionSelector } from '@renderer/features/projects/components/add-project-modal/k8s-connection-selector';
import { SshConnectionSelector } from '@renderer/features/projects/components/add-project-modal/ssh-connection-selector';
import {
  getProjectManagerStore,
  getProjectStore,
} from '@renderer/features/projects/stores/project-selectors';
import { useShowModal, type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';

export interface ChangeProjectConnectionModalProps {
  projectId: string;
  currentConnectionId: string;
}

export function ChangeProjectConnectionModal({
  projectId,
  currentConnectionId,
  onSuccess,
  onClose,
}: ChangeProjectConnectionModalProps & BaseModalProps<void>) {
  const [selectedConnectionId, setSelectedConnectionId] = useState(currentConnectionId);
  const [isSaving, setIsSaving] = useState(false);

  const transport = getProjectStore(projectId)?.data?.type === 'k8s' ? 'k8s' : 'ssh';
  const isK8s = transport === 'k8s';
  const label = isK8s ? 'Kubernetes' : 'SSH';

  const showSshConnModal = useShowModal('addSshConnModal');
  const showK8sConnModal = useShowModal('addK8sConnModal');
  const showAddConnModal = isK8s ? showK8sConnModal : showSshConnModal;
  const showChangeConnectionModal = useShowModal('changeProjectConnectionModal');

  const handleAddConnection = () => {
    showAddConnModal({
      onSuccess: (result: { connectionId: string }) => {
        showChangeConnectionModal({ projectId, currentConnectionId: result.connectionId });
      },
      onClose: () => {
        showChangeConnectionModal({ projectId, currentConnectionId: selectedConnectionId });
      },
    });
  };

  const handleEditConnection = (id: string) => {
    const reopen = () => showChangeConnectionModal({ projectId, currentConnectionId: id });
    if (isK8s) {
      const conn = appState.k8sConnections.connections.find((c) => c.id === id);
      if (!conn) return;
      showK8sConnModal({ initialConfig: conn, onSuccess: reopen, onClose: reopen });
    } else {
      const conn = appState.sshConnections.connections.find((c) => c.id === id);
      if (!conn) return;
      showSshConnModal({ initialConfig: conn, onSuccess: reopen, onClose: reopen });
    }
  };

  const handleSave = async () => {
    if (selectedConnectionId === currentConnectionId) {
      onClose();
      return;
    }
    setIsSaving(true);
    try {
      await getProjectManagerStore()?.updateProjectConnection(projectId, selectedConnectionId);
      onSuccess();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalLayout
      header={
        <DialogHeader>
          <DialogTitle>Change {label} Connection</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <ConfirmButton
            onClick={() => void handleSave()}
            disabled={isSaving || !selectedConnectionId}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </ConfirmButton>
        </DialogFooter>
      }
    >
      <DialogContentArea>
        <Field>
          <FieldLabel>{label} Connection</FieldLabel>
          {isK8s ? (
            <K8sConnectionSelector
              connectionId={selectedConnectionId}
              onConnectionIdChange={setSelectedConnectionId}
              onAddConnection={handleAddConnection}
              onEditConnection={handleEditConnection}
            />
          ) : (
            <SshConnectionSelector
              connectionId={selectedConnectionId}
              onConnectionIdChange={setSelectedConnectionId}
              onAddConnection={handleAddConnection}
              onEditConnection={handleEditConnection}
            />
          )}
        </Field>
      </DialogContentArea>
    </ModalLayout>
  );
}
