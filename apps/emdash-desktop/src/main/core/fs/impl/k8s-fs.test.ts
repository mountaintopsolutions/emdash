import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_REMOTE_SHELL_PROFILE } from '@main/core/execution-context/remote-shell-profile';
import type { ExecResult } from '@shared/kubernetes';
import type { FileEntry, FileListResult } from '../types';
import { K8sFileSystem } from './k8s-fs';

function listResult(entries: FileEntry[]): FileListResult {
  return { entries, total: entries.length };
}

function fileEntry(path: string, mtimeMs: number, size = 1): FileEntry {
  return {
    path,
    type: 'file',
    size,
    mtime: new Date(mtimeMs),
    mode: 0o100644,
  };
}

/**
 * Minimal fake KubeClientProxy: records the shell commands `exec` receives and
 * returns a canned ExecResult for each call.
 */
function makeProxy(results: ExecResult[]) {
  const execCalls: string[] = [];
  const proxy = {
    getRemoteShellProfile: vi.fn(async () => FALLBACK_REMOTE_SHELL_PROFILE),
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      execCalls.push(command);
      return results.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFileBytes: vi.fn(async () => {}),
    readFileBytes: vi.fn(async () => Buffer.alloc(0)),
  };
  return { proxy, execCalls };
}

describe('K8sFileSystem.mkdir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues mkdir -p for recursive directory creation', async () => {
    const { proxy, execCalls } = makeProxy([{ stdout: '', stderr: '', exitCode: 0 }]);
    const fs = new K8sFileSystem(proxy as never, '/repo');

    await expect(fs.mkdir('parent/child', { recursive: true })).resolves.toBeUndefined();

    expect(execCalls).toHaveLength(1);
    // The command is wrapped by buildRemoteShellCommand (sh -c '<quoted>'),
    // so assert the inner mkdir and the quoted target survive intact.
    expect(execCalls[0]).toContain('mkdir -p');
    expect(execCalls[0]).toContain('/repo/parent/child');
  });

  it('rejects when mkdir exits non-zero', async () => {
    const { proxy } = makeProxy([{ stdout: '', stderr: 'Permission denied', exitCode: 1 }]);
    const fs = new K8sFileSystem(proxy as never, '/repo');

    await expect(fs.mkdir('denied', { recursive: true })).rejects.toThrow('Permission denied');
  });
});

describe('K8sFileSystem.write', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ensures the parent directory then streams bytes to a cat redirect', async () => {
    const { proxy } = makeProxy([{ stdout: '', stderr: '', exitCode: 0 }]);
    const fs = new K8sFileSystem(proxy as never, '/repo');

    const result = await fs.write('dir/file.txt', 'hello');

    expect(result).toEqual({ success: true, bytesWritten: 5 });
    expect(proxy.writeFileBytes).toHaveBeenCalledWith(
      "cat > '/repo/dir/file.txt'",
      Buffer.from('hello', 'utf-8')
    );
  });
});

describe('K8sFileSystem path traversal', () => {
  it('rejects paths that escape the base directory', async () => {
    const { proxy } = makeProxy([]);
    const fs = new K8sFileSystem(proxy as never, '/repo');

    // An absolute path outside the base must be rejected (mirrors SshFileSystem).
    await expect(fs.read('/etc/passwd')).rejects.toThrow('Path traversal detected');
  });
});

describe('K8sFileSystem.watch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits modify events when an existing polled file changes metadata', async () => {
    vi.useFakeTimers();

    const { proxy } = makeProxy([]);
    const fs = new K8sFileSystem(proxy as never, '/repo');
    vi.spyOn(fs, 'list')
      .mockResolvedValueOnce(listResult([fileEntry('notes.md', 1_000)]))
      .mockResolvedValueOnce(listResult([fileEntry('notes.md', 2_000)]));

    const events: Array<{ type: string; entryType: string; path: string }> = [];
    const watcher = fs.watch((batch) => events.push(...batch), { debounceMs: 10 });
    watcher.update(['']);

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([{ type: 'modify', entryType: 'file', path: 'notes.md' }]);

    watcher.close();
  });
});
