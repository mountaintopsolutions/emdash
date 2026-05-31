import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateProjectConnection } from './updateProjectConnection';

const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mocks.selectWhere,
      }),
    }),
    update: () => ({
      set: mocks.updateSet,
    }),
  },
}));

describe('updateProjectConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it('throws when the project does not exist', async () => {
    mocks.selectWhere.mockResolvedValue([]);

    await expect(updateProjectConnection('missing', 'conn-1')).rejects.toThrow(
      'Project missing not found'
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('updates the ssh connection id for an ssh project', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'p-1', workspaceProvider: 'ssh' }]);

    await updateProjectConnection('p-1', 'ssh-conn');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ sshConnectionId: 'ssh-conn', updatedAt: expect.any(String) })
    );
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });

  it('updates the k8s connection id for a k8s project', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'p-1', workspaceProvider: 'k8s' }]);

    await updateProjectConnection('p-1', 'k8s-conn');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ k8sConnectionId: 'k8s-conn', updatedAt: expect.any(String) })
    );
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });

  it('throws for a workspace provider that does not support remote connections', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'p-1', workspaceProvider: 'local' }]);

    await expect(updateProjectConnection('p-1', 'conn-1')).rejects.toThrow(
      /does not support remote connections/
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
