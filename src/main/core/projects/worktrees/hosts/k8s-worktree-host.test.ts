import { describe, expect, it, vi } from 'vitest';
import { FileSystemErrorCodes, type FileSystemProvider } from '@main/core/fs/types';
import { K8sWorktreeHost } from './k8s-worktree-host';

function makeFs(): Pick<
  FileSystemProvider,
  'exists' | 'mkdir' | 'remove' | 'realPath' | 'glob' | 'read' | 'copyFile' | 'stat'
> {
  return {
    exists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue({ success: true }),
    realPath: vi.fn().mockResolvedValue('/real/path'),
    glob: vi.fn().mockResolvedValue(['.env']),
    read: vi.fn().mockResolvedValue({ content: 'hello', truncated: false, totalSize: 5 }),
    copyFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue(null),
  };
}

describe('K8sWorktreeHost', () => {
  it('delegates absolute POSIX paths to the wrapped filesystem', async () => {
    const fs = makeFs();
    const host = new K8sWorktreeHost(fs);

    await host.mkdirAbsolute('/pod/worktrees/project', { recursive: true });
    await host.copyFileAbsolute('/pod/repo/.env', '/pod/worktrees/project/task/.env');
    await host.globAbsolute('.env', { cwd: '/pod/repo', dot: true });

    expect(fs.mkdir).toHaveBeenCalledWith('/pod/worktrees/project', { recursive: true });
    expect(fs.copyFile).toHaveBeenCalledWith('/pod/repo/.env', '/pod/worktrees/project/task/.env');
    expect(fs.glob).toHaveBeenCalledWith('.env', { cwd: '/pod/repo', dot: true });
  });

  it('rejects relative paths before delegating', async () => {
    const fs = makeFs();
    const host = new K8sWorktreeHost(fs);

    await expect(host.existsAbsolute('relative/path')).rejects.toMatchObject({
      code: FileSystemErrorCodes.INVALID_PATH,
    });
    expect(fs.exists).not.toHaveBeenCalled();
  });
});
