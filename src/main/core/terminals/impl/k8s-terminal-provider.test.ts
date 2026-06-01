import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { PtyExitInfo } from '@main/core/pty/pty';
import { makePtySessionId } from '@shared/ptySessionId';
import type { Terminal } from '@shared/terminals';
import { K8sTerminalProvider } from './k8s-terminal-provider';

const ptyMock = vi.hoisted(() => ({
  exitHandlers: [] as Array<(info: PtyExitInfo) => void>,
}));

vi.mock('@main/core/pty/k8s-pty', () => ({
  openK8sPty: vi.fn(async () => ({
    success: true,
    data: {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((handler: (info: PtyExitInfo) => void) => {
        ptyMock.exitHandlers.push(handler);
      }),
    },
  })),
}));

vi.mock('@main/core/pty/pty-session-registry', () => ({
  ptySessionRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));

vi.mock('@main/core/k8s/lifecycle/production-kube-connection-manager', () => ({
  kubeConnectionManager: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../dev-server-watcher', () => ({
  wireTerminalDevServerWatcher: vi.fn(),
}));

const terminal: Terminal = {
  id: 'terminal-1',
  projectId: 'project-1',
  taskId: 'task-1',
  name: 'Terminal 1',
  shellId: 'system',
};

const ctx = {
  supportsLocalSpawn: false,
  exec: vi.fn(),
  execStreaming: vi.fn(),
  dispose: vi.fn(),
} satisfies IExecutionContext;

const proxy = {
  getRemoteShellProfile: vi.fn(async () => ({
    shell: '/bin/bash',
    env: { PATH: '/usr/bin', HOME: '/home/me' },
  })),
} satisfies Partial<KubeClientProxy> as unknown as KubeClientProxy;

describe('K8sTerminalProvider', () => {
  beforeEach(() => {
    ptyMock.exitHandlers.length = 0;
    proxy.getRemoteShellProfile = vi.fn(async () => ({
      shell: '/bin/bash',
      env: { PATH: '/usr/bin', HOME: '/home/me' },
    }));
  });

  it('cleans up cached shell profiles after a non-respawned exit', async () => {
    const provider = new K8sTerminalProvider({
      projectId: terminal.projectId,
      scopeId: terminal.taskId,
      taskPath: '/repo',
      ctx,
      proxy,
      connectionId: 'k8s-1',
    });

    await provider.spawnLifecycleScript({
      terminal,
      command: 'echo ready',
    });

    const sessionId = makePtySessionId(terminal.projectId, terminal.taskId, terminal.id);
    expect(
      (provider as unknown as { shellProfiles: Map<string, unknown> }).shellProfiles.has(sessionId)
    ).toBe(true);

    for (const handler of ptyMock.exitHandlers) handler({ exitCode: 0 });

    expect(
      (provider as unknown as { shellProfiles: Map<string, unknown> }).shellProfiles.has(sessionId)
    ).toBe(false);
  });
});
