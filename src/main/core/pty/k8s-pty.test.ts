import { describe, expect, it, vi } from 'vitest';
import type { KubePtyHandle } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { openK8sPty } from './k8s-pty';
import type { PtyExitInfo } from './pty';

function makeHandle() {
  const dataListeners: Array<(chunk: string) => void> = [];
  const closeListeners: Array<(exitCode: number | null) => void> = [];
  const handle: KubePtyHandle = {
    write: vi.fn(),
    onData: vi.fn((listener) => dataListeners.push(listener)),
    onClose: vi.fn((listener) => closeListeners.push(listener)),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return { handle, dataListeners, closeListeners };
}

describe('openK8sPty', () => {
  it('runs the command via /bin/sh -c and forwards write/resize/kill', async () => {
    const { handle } = makeHandle();
    const execPty = vi.fn(() => handle);
    const proxy = { execPty } as never;

    const result = await openK8sPty(proxy, {
      id: 'pty-1',
      command: 'agent --run',
      cols: 80,
      rows: 24,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(execPty).toHaveBeenCalledWith(['/bin/sh', '-c', 'agent --run'], { cols: 80, rows: 24 });

    const session = result.data;
    session.write('input');
    session.resize(100, 40);
    session.kill();
    expect(handle.write).toHaveBeenCalledWith('input');
    expect(handle.resize).toHaveBeenCalledWith(100, 40);
    expect(handle.kill).toHaveBeenCalled();
  });

  it('maps onClose to PtyExitInfo, defaulting an unknown exit code to undefined', async () => {
    const { handle, dataListeners, closeListeners } = makeHandle();
    const proxy = { execPty: vi.fn(() => handle) } as never;

    const result = await openK8sPty(proxy, { id: 'pty-2', command: 'sh', cols: 80, rows: 24 });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data: string[] = [];
    const exits: PtyExitInfo[] = [];
    result.data.onData((chunk) => data.push(chunk));
    result.data.onExit((info) => exits.push(info));

    dataListeners[0]('output');
    closeListeners[0](0);
    closeListeners[0](null);

    expect(data).toEqual(['output']);
    expect(exits).toEqual([
      { exitCode: 0, signal: undefined },
      { exitCode: undefined, signal: undefined },
    ]);
  });

  it('returns a channel-open-failed error when execPty throws', async () => {
    const proxy = {
      execPty: vi.fn(() => {
        throw new Error('not connected');
      }),
    } as never;

    const result = await openK8sPty(proxy, { id: 'pty-3', command: 'sh', cols: 80, rows: 24 });

    expect(result).toEqual({
      success: false,
      error: { kind: 'channel-open-failed', message: 'not connected' },
    });
  });
});
