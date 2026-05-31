import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const instances: Array<{
    ctx: unknown;
    options: unknown;
    get: ReturnType<typeof vi.fn>;
    probeCategory: ReturnType<typeof vi.fn>;
    onExecutableInvalidated: { subscribe: ReturnType<typeof vi.fn> };
    setAgentStates(): void;
  }> = [];

  class FakeHostDependencyManager {
    private readonly states = new Map<string, { id: string; category: string }>();
    readonly get = vi.fn((id: string) => this.states.get(id));
    readonly probeCategory = vi.fn(async (category: string) => {
      if (category === 'agent') {
        this.states.set('claude', { id: 'claude', category: 'agent' });
        this.states.set('codex', { id: 'codex', category: 'agent' });
      }
    });
    readonly onExecutableInvalidated = { subscribe: vi.fn() };

    setAgentStates(): void {
      this.states.set('claude', { id: 'claude', category: 'agent' });
      this.states.set('codex', { id: 'codex', category: 'agent' });
    }

    constructor(
      public ctx: unknown,
      public options: unknown
    ) {
      instances.push(this);
    }
  }

  return {
    instances,
    FakeHostDependencyManager,
    attach: vi.fn(),
    clearResolvedPathCache: vi.fn(),
    sshConnect: vi.fn(),
    kubeConnect: vi.fn(),
    getSelection: vi.fn(),
    limit: vi.fn(),
    createLocalInstallCommandRunner: vi.fn(() => vi.fn()),
    createSshInstallCommandRunner: vi.fn(() => vi.fn()),
    createK8sInstallCommandRunner: vi.fn(() => vi.fn()),
  };
});

vi.mock('@emdash/core/deps/runtime', () => ({
  HostDependencyManager: mocks.FakeHostDependencyManager,
}));

vi.mock('@main/core/conversations/impl/resolve-agent-executable', () => ({
  clearResolvedPathCache: mocks.clearResolvedPathCache,
}));

vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {},
}));

vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    async exec() {
      return { stdout: 'Linux\n', stderr: '' };
    }
  },
}));

vi.mock('@main/core/execution-context/k8s-execution-context', () => ({
  K8sExecutionContext: class {
    async exec() {
      return { stdout: 'Linux\n', stderr: '' };
    }
  },
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn(async () => ({ defaultShell: null })),
  },
}));

vi.mock('@main/core/ssh/lifecycle/production-ssh-connection-manager', () => ({
  sshConnectionManager: {
    connect: mocks.sshConnect,
  },
}));

vi.mock('@main/core/k8s/lifecycle/production-kube-connection-manager', () => ({
  kubeConnectionManager: {
    connect: mocks.kubeConnect,
  },
}));

vi.mock('@main/core/terminal-shell/resolver', () => ({
  resolveLocalAutomationShellWithSystemFallback: vi.fn(async () => ({ shell: '/bin/sh' })),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.limit,
        }),
      }),
    }),
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock('./agent-update-service', () => ({
  agentUpdateService: {
    attach: mocks.attach,
  },
}));

vi.mock('./host-dependency-store', () => ({
  hostDependencyStore: {
    getSelection: mocks.getSelection,
  },
}));

vi.mock('./install-runner', () => ({
  createLocalInstallCommandRunner: mocks.createLocalInstallCommandRunner,
  createSshInstallCommandRunner: mocks.createSshInstallCommandRunner,
  createK8sInstallCommandRunner: mocks.createK8sInstallCommandRunner,
}));

vi.mock('./registry', () => ({
  DEPENDENCIES: [
    { id: 'claude', category: 'agent' },
    { id: 'codex', category: 'agent' },
    { id: 'git', category: 'core' },
  ],
  AGENT_DEPENDENCIES: [
    { id: 'claude', category: 'agent' },
    { id: 'codex', category: 'agent' },
  ],
  getDependencyDescriptor: vi.fn(),
}));

describe('ensureAgentDependenciesProbed', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.instances.length = 0;
    // Default: connection ids are not k8s, so getDependencyManager uses SSH.
    mocks.limit.mockResolvedValue([]);
    mocks.sshConnect.mockResolvedValue({});
    mocks.kubeConnect.mockResolvedValue({});
  });

  it('deduplicates concurrent first-use probes for the same host', async () => {
    const { ensureAgentDependenciesProbed, getDependencyManager } =
      await import('./dependency-managers');
    const manager = await getDependencyManager();
    const fakeManager = mocks.instances[0]!;
    let resolveProbe: (() => void) | undefined;
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    fakeManager.probeCategory.mockReturnValue(probe);

    const first = ensureAgentDependenciesProbed(manager);
    const second = ensureAgentDependenciesProbed(manager);
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeManager.probeCategory).toHaveBeenCalledTimes(1);
    expect(fakeManager.probeCategory).toHaveBeenCalledWith('agent', { refreshShellEnv: true });

    if (!resolveProbe) throw new Error('Probe did not start');
    fakeManager.setAgentStates();
    resolveProbe();
    await Promise.all([first, second]);
  });

  it('does not probe again after the first probe completes', async () => {
    const { ensureAgentDependenciesProbed, getDependencyManager } =
      await import('./dependency-managers');
    const manager = await getDependencyManager();
    const fakeManager = mocks.instances[0]!;

    await ensureAgentDependenciesProbed(manager);
    await ensureAgentDependenciesProbed(manager);

    expect(fakeManager.probeCategory).toHaveBeenCalledTimes(1);
  });

  it('keeps manager access separate from explicit agent probing', async () => {
    const { ensureAgentDependenciesProbed, getDependencyManager } =
      await import('./dependency-managers');
    const localManager = mocks.instances[0]!;

    await expect(getDependencyManager()).resolves.toBe(localManager);
    expect(localManager.probeCategory).not.toHaveBeenCalled();

    const remoteManager = await getDependencyManager('ssh-1');
    expect(remoteManager.probeCategory).not.toHaveBeenCalled();

    await ensureAgentDependenciesProbed(remoteManager);

    expect(remoteManager.probeCategory).toHaveBeenCalledWith('agent', { refreshShellEnv: true });
    await expect(getDependencyManager('ssh-1')).resolves.toBe(remoteManager);
  });

  it('deduplicates concurrent remote manager creation', async () => {
    const { getDependencyManager } = await import('./dependency-managers');
    let resolveConnect: ((proxy: unknown) => void) | undefined;
    mocks.sshConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      })
    );

    const first = getDependencyManager('ssh-1');
    const second = getDependencyManager('ssh-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.sshConnect).toHaveBeenCalledTimes(1);

    if (!resolveConnect) throw new Error('Connect did not start');
    resolveConnect({});

    const [firstManager, secondManager] = await Promise.all([first, second]);
    expect(firstManager).toBe(secondManager);
    expect(firstManager).toBe(mocks.instances[1]);
    expect(mocks.instances).toHaveLength(2);
  });

  it('does not share in-flight probes across manager instances', async () => {
    const { clearDependencyManager, ensureAgentDependenciesProbed, getDependencyManager } =
      await import('./dependency-managers');

    const firstManager = await getDependencyManager('ssh-1');
    const firstFakeManager = mocks.instances[1]!;
    clearDependencyManager('ssh-1');
    const secondManager = await getDependencyManager('ssh-1');
    const secondFakeManager = mocks.instances[2]!;

    let resolveFirstProbe: (() => void) | undefined;
    let resolveSecondProbe: (() => void) | undefined;
    firstFakeManager.probeCategory.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFirstProbe = resolve;
      })
    );
    secondFakeManager.probeCategory.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSecondProbe = resolve;
      })
    );

    const firstProbe = ensureAgentDependenciesProbed(firstManager);
    const secondProbe = ensureAgentDependenciesProbed(secondManager);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstFakeManager.probeCategory).toHaveBeenCalledTimes(1);
    expect(secondFakeManager.probeCategory).toHaveBeenCalledTimes(1);

    if (!resolveFirstProbe || !resolveSecondProbe) throw new Error('Probes did not start');
    firstFakeManager.setAgentStates();
    secondFakeManager.setAgentStates();
    resolveFirstProbe();
    resolveSecondProbe();
    await Promise.all([firstProbe, secondProbe]);
  });

  it('clears cached remote managers explicitly', async () => {
    const { clearDependencyManager, getDependencyManager } = await import('./dependency-managers');

    const first = await getDependencyManager('ssh-1');
    clearDependencyManager('ssh-1');
    const second = await getDependencyManager('ssh-1');

    expect(second).not.toBe(first);
    expect(mocks.sshConnect).toHaveBeenCalledTimes(2);
  });

  it('keeps in-flight probes deduped for a manager after cache clear', async () => {
    const { clearDependencyManager, ensureAgentDependenciesProbed, getDependencyManager } =
      await import('./dependency-managers');
    const manager = await getDependencyManager('ssh-1');
    const fakeManager = mocks.instances[1]!;
    let resolveProbe: (() => void) | undefined;
    fakeManager.probeCategory.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProbe = resolve;
      })
    );

    const first = ensureAgentDependenciesProbed(manager);
    await Promise.resolve();
    await Promise.resolve();
    clearDependencyManager('ssh-1');
    const second = ensureAgentDependenciesProbed(manager);

    expect(fakeManager.probeCategory).toHaveBeenCalledTimes(1);

    if (!resolveProbe) throw new Error('Probe did not start');
    fakeManager.setAgentStates();
    resolveProbe();
    await Promise.all([first, second]);
  });
});

describe('getDependencyManager transport dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.instances.length = 0;
    mocks.sshConnect.mockResolvedValue({});
    mocks.kubeConnect.mockResolvedValue({});
    mocks.limit.mockReset();
  });

  it('returns the local manager when no connection id is provided', async () => {
    const { getDependencyManager } = await import('./dependency-managers');
    const localManager = mocks.instances[0]!;

    const mgr = await getDependencyManager();

    expect(mgr).toBe(localManager);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it('uses the k8s transport when the connection id matches a k8s connection', async () => {
    mocks.limit.mockResolvedValue([{ id: 'k8s-1' }]);
    const { getDependencyManager } = await import('./dependency-managers');

    const mgr = await getDependencyManager('k8s-1');

    expect(mgr).toBe(mocks.instances[1]);
    expect(mocks.kubeConnect).toHaveBeenCalledWith('k8s-1');
    expect(mocks.sshConnect).not.toHaveBeenCalled();
    // The k8s install-runner path is taken for k8s connections.
    expect(mocks.createK8sInstallCommandRunner).toHaveBeenCalledTimes(1);
    expect(mocks.createSshInstallCommandRunner).not.toHaveBeenCalled();
  });

  it('falls back to the ssh transport when no k8s connection matches', async () => {
    mocks.limit.mockResolvedValue([]);
    const { getDependencyManager } = await import('./dependency-managers');

    const mgr = await getDependencyManager('ssh-1');

    expect(mgr).toBe(mocks.instances[1]);
    expect(mocks.sshConnect).toHaveBeenCalledWith('ssh-1');
    expect(mocks.kubeConnect).not.toHaveBeenCalled();
    expect(mocks.createSshInstallCommandRunner).toHaveBeenCalledTimes(1);
    expect(mocks.createK8sInstallCommandRunner).not.toHaveBeenCalled();
  });

  it('caches the manager per connection id', async () => {
    mocks.limit.mockResolvedValue([{ id: 'k8s-cache' }]);
    const { getDependencyManager } = await import('./dependency-managers');

    const first = await getDependencyManager('k8s-cache');
    const second = await getDependencyManager('k8s-cache');

    expect(first).toBe(second);
    expect(mocks.kubeConnect).toHaveBeenCalledTimes(1);
  });
});
