import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import type { PtyExitInfo } from '@main/core/pty/pty';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { Terminal } from '@shared/core/terminals/terminals';
import { K8sTerminalProvider } from './k8s-terminal-provider';

const ptyMock = vi.hoisted(() => ({
  exitHandlers: [] as Array<(info: PtyExitInfo) => void>,
}));

const previewServerServiceMock = vi.hoisted(() => ({
  registerDetectedTarget: vi.fn(),
  handleTerminalSourceClosed: vi.fn(),
}));

const terminalUrlDetectorMock = vi.hoisted(() => ({
  wireTerminalUrlDetector: vi.fn(),
}));

vi.mock('@main/core/preview-servers/preview-server-service-instance', () => ({
  previewServerService: previewServerServiceMock,
}));

vi.mock('@main/core/preview-servers/terminal-url-detector', () => ({
  wireTerminalUrlDetector: terminalUrlDetectorMock.wireTerminalUrlDetector,
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

const dbMock = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbMock.rows,
        }),
      }),
    }),
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
    dbMock.rows = [];
    terminalUrlDetectorMock.wireTerminalUrlDetector.mockClear();
    previewServerServiceMock.registerDetectedTarget.mockClear();
    previewServerServiceMock.registerDetectedTarget.mockResolvedValue(undefined);
    previewServerServiceMock.handleTerminalSourceClosed.mockClear();
    proxy.getRemoteShellProfile = vi.fn(async () => ({
      shell: '/bin/bash',
      env: { PATH: '/usr/bin', HOME: '/home/me' },
    }));
  });

  it('cleans up cached shell profiles after a non-respawned exit', async () => {
    const provider = new K8sTerminalProvider({
      projectId: terminal.projectId,
      workspaceId: 'workspace-9',
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

  it('reads tmux live from the connection so toggling it applies to new sessions', async () => {
    // Connection metadata enables tmux even though the provider was constructed
    // with tmux off — the live read must win.
    dbMock.rows = [
      {
        id: 'k8s-1',
        name: 'Stored',
        context: 'kind-dev',
        namespace: 'default',
        podName: 'workspace-pod',
        containerName: null,
        kubeconfigPath: null,
        metadata: JSON.stringify({ tmux: true }),
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ];

    const provider = new K8sTerminalProvider({
      projectId: terminal.projectId,
      workspaceId: 'workspace-9',
      scopeId: terminal.taskId,
      taskPath: '/repo',
      tmux: false,
      ctx,
      proxy,
      connectionId: 'k8s-1',
    });

    await provider.spawnTerminal(terminal);

    const sessionId = makePtySessionId(terminal.projectId, terminal.taskId, terminal.id);
    expect((provider as unknown as { tmuxSessions: Set<string> }).tmuxSessions.has(sessionId)).toBe(
      true
    );
  });

  it('registers detected preview URLs against the k8s scope and connection', async () => {
    const provider = new K8sTerminalProvider({
      projectId: terminal.projectId,
      workspaceId: 'workspace-9',
      scopeId: terminal.taskId,
      taskPath: '/repo',
      ctx,
      proxy,
      connectionId: 'k8s-1',
    });

    await provider.spawnTerminal(terminal);

    const detectorOptions = terminalUrlDetectorMock.wireTerminalUrlDetector.mock.calls[0]?.[0];
    expect(detectorOptions).toMatchObject({ probeLocalPorts: false });

    detectorOptions.onDetected({
      protocol: 'http:',
      host: '127.0.0.1',
      port: 5173,
      urlPath: '/',
    });

    expect(previewServerServiceMock.registerDetectedTarget).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-9',
      connectionId: 'k8s-1',
      transport: 'k8s',
      proxy,
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      port: 5173,
      urlPath: '/',
    });
  });
});
