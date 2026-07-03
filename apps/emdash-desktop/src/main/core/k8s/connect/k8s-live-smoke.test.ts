import { describe, expect, it } from 'vitest';
import { K8sFileSystem } from '@main/core/runtime/legacy/k8s-legacy-fs';
import { openPortForwardTunnel } from '@main/core/port-forwards/port-forward-tunnel';
import { K8sWorktreeHost } from '@main/core/projects/worktrees/hosts/k8s-worktree-host';
import { openK8sPty } from '@main/core/pty/k8s-pty';
import {
  listKubeConfigContexts,
  listNamespacesForContext,
  listPodsForContext,
  loadKubeConfig,
} from '../config/kubeconfig-parser';
import { KubeClientProxy } from '../lifecycle/kube-client-proxy';
import { verifyPodRunning } from '../lifecycle/kube-connection-manager';
import { resolveKubeConnectConfig } from './resolve-kube-connect-config';

/**
 * Live transport smoke test against a real cluster/pod. Skipped unless
 * K8S_LIVE_TEST=1 so it never runs in the normal suite or CI.
 *
 * Run it with:
 *   K8S_LIVE_TEST=1 pnpm exec vitest run --project node \
 *     src/main/core/k8s/connect/k8s-live-smoke.test.ts
 *
 * Target is overridable via env (defaults to the shared dev pod):
 *   K8S_TEST_CONTEXT, K8S_TEST_NAMESPACE, K8S_TEST_POD, K8S_TEST_CONTAINER
 */
const LIVE = process.env.K8S_LIVE_TEST === '1';

describe.runIf(LIVE)('k8s live transport smoke', () => {
  const config = {
    id: 'live-smoke',
    name: 'live-smoke',
    context: process.env.K8S_TEST_CONTEXT ?? 'admin@chaos-mi250-dev',
    namespace: process.env.K8S_TEST_NAMESPACE ?? 'models',
    podName: process.env.K8S_TEST_POD ?? 'pytorch-dev-pod-dale',
    containerName: process.env.K8S_TEST_CONTAINER,
    kubeconfigPath: process.env.K8S_TEST_KUBECONFIG,
  };

  it('resolves, verifies pod Running, execs, captures shell profile, and lists files', async () => {
    const resolved = await resolveKubeConnectConfig(
      { kind: 'transient', config },
      { loadKubeConfig, getToken: async () => null }
    );
    // eslint-disable-next-line no-console
    console.log('[smoke] resolved context:', resolved.context, 'target:', resolved.target);

    await verifyPodRunning(resolved);

    const proxy = new KubeClientProxy(config.id);
    proxy.update(resolved.kc, resolved.target);

    const out = await proxy.exec('echo hello-from-emdash; whoami; pwd; uname -sm');
    // eslint-disable-next-line no-console
    console.log('[smoke] exec stdout:\n' + out.stdout);
    if (out.stderr) console.log('[smoke] exec stderr:\n' + out.stderr);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('hello-from-emdash');

    // Exit-code propagation (Codex flagged the V1Status exit-code extraction).
    const failed = await proxy.exec('exit 7');
    // eslint-disable-next-line no-console
    console.log('[smoke] exit-code probe ->', failed.exitCode);
    expect(failed.exitCode).toBe(7);

    const profile = await proxy.getRemoteShellProfile();
    // eslint-disable-next-line no-console
    console.log('[smoke] shell profile:', profile.shell, 'PATH=', profile.env.PATH);
    expect(profile.shell).toBeTruthy();

    const fs = new K8sFileSystem(proxy, '/');
    const listing = await fs.list('/');
    // eslint-disable-next-line no-console
    console.log(
      '[smoke] / listing (first 10):',
      listing.entries.slice(0, 10).map((e) => `${e.type}:${e.path}`)
    );
    expect(listing.entries.length).toBeGreaterThan(0);

    // stat must report a directory as 'dir' — createK8sProject relies on
    // fs.stat('') to validate the chosen path (regression guard: `stat -c` does
    // not interpret backslash escapes, so the delimiter must not be `\t`).
    const rootStat = await fs.stat('');
    // eslint-disable-next-line no-console
    console.log('[smoke] fs.stat("") for / ->', JSON.stringify(rootStat));
    expect(rootStat?.type).toBe('dir');
  }, 60_000);

  async function connect(): Promise<KubeClientProxy> {
    const resolved = await resolveKubeConnectConfig(
      { kind: 'transient', config },
      { loadKubeConfig, getToken: async () => null }
    );
    await verifyPodRunning(resolved);
    const proxy = new KubeClientProxy(config.id);
    proxy.update(resolved.kc, resolved.target);
    return proxy;
  }

  it('writes, reads, globs, and removes files via K8sFileSystem', async () => {
    const proxy = await connect();
    const dir = '/tmp/emdash-k8s-fs-smoke';
    const fs = new K8sFileSystem(proxy, dir);
    await fs.remove('', { recursive: true }).catch(() => {});
    await fs.mkdir('', { recursive: true });
    await fs.write('hello.txt', 'k8s-roundtrip-marker\n');

    const read = await fs.read('hello.txt');
    expect(read.content).toContain('k8s-roundtrip-marker');

    const matches = await fs.glob('hello.txt', { cwd: '/', dot: false });
    // eslint-disable-next-line no-console
    console.log('[smoke] glob matches:', matches.length);
    expect(matches.length).toBeGreaterThan(0);

    const removed = await fs.remove('hello.txt');
    expect(removed.success).toBe(true);
    expect(await fs.exists('hello.txt')).toBe(false);
    await fs.remove('', { recursive: true }).catch(() => {});
  }, 60_000);

  it('worktree host: mkdir/exists/remove (absolute)', async () => {
    const proxy = await connect();
    const host = new K8sWorktreeHost(new K8sFileSystem(proxy, '/'));
    const dir = '/tmp/emdash-k8s-wt-smoke';
    await host.removeAbsolute(dir, { recursive: true }).catch(() => {});
    await host.mkdirAbsolute(dir, { recursive: true });
    expect(await host.existsAbsolute(dir)).toBe(true);
    await host.removeAbsolute(dir, { recursive: true });
    expect(await host.existsAbsolute(dir)).toBe(false);
  }, 60_000);

  it('opens a PTY, resizes (channel-4 framing), runs a command, and exits', async () => {
    const proxy = await connect();
    const result = await openK8sPty(proxy, { id: 'smoke-pty', command: 'sh', cols: 80, rows: 24 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const session = result.data;

    let output = '';
    session.onData((d) => {
      output += d;
    });

    const info = await new Promise<{ exitCode?: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('PTY did not exit; output=' + JSON.stringify(output))),
        20_000
      );
      session.onExit((i) => {
        clearTimeout(timer);
        resolve(i);
      });
      // Resize BEFORE the command — exercises the channel-4 resize message; a
      // broken frame would corrupt or close the stream.
      session.resize(120, 40);
      session.write('echo pty-marker-ok\n');
      session.write('exit\n');
    });

    // eslint-disable-next-line no-console
    console.log('[smoke] pty output:', JSON.stringify(output), 'exit:', info.exitCode);
    expect(output).toContain('pty-marker-ok');
  }, 40_000);

  it('keeps an idle PTY alive past the keepalive interval', async () => {
    const proxy = await connect();
    const result = await openK8sPty(proxy, {
      id: 'smoke-pty-idle',
      command: 'sh',
      cols: 80,
      rows: 24,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const session = result.data;

    let output = '';
    let exited = false;
    session.onData((d) => {
      output += d;
    });
    session.onExit(() => {
      exited = true;
    });

    // Idle past the 15s keepalive ping. Without keepalive an idle exec stream
    // (especially through a proxy like Teleport) can be reaped during this gap.
    await new Promise((r) => setTimeout(r, 22_000));
    expect(exited).toBe(false);

    session.write('echo still-alive\n');
    session.write('exit\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('idle PTY unresponsive; output=' + JSON.stringify(output))),
        15_000
      );
      const poll = setInterval(() => {
        if (output.includes('still-alive')) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 250);
    });
    // eslint-disable-next-line no-console
    console.log('[smoke] idle pty survived; output tail:', JSON.stringify(output.slice(-60)));
    expect(output).toContain('still-alive');
  }, 60_000);

  it('forwards a pod port to localhost via PortForward (preview path)', async () => {
    const proxy = await connect();
    const remotePort = 18080;
    // Apply the login shell's PATH so python3 (often in a conda/venv prefix) is
    // found — a bare exec PTY doesn't source the profile the way a terminal does.
    const profile = await proxy.getRemoteShellProfile();
    const remotePath = profile.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

    // Serve a marker page from inside the pod on a loopback-only port.
    const ptyResult = await openK8sPty(proxy, {
      id: 'smoke-portforward',
      command: 'sh',
      cols: 80,
      rows: 24,
    });
    expect(ptyResult.success).toBe(true);
    if (!ptyResult.success) return;
    const server = ptyResult.data;
    let serverOutput = '';
    server.onData((d) => {
      serverOutput += d;
    });
    server.write(
      `export PATH="${remotePath}"; ` +
        `mkdir -p /tmp/emdash-pf-smoke && cd /tmp/emdash-pf-smoke && ` +
        `printf 'k8s-portforward-marker' > index.html && ` +
        `(command -v python3 || echo NO_PYTHON3) && ` +
        `python3 -m http.server ${remotePort} --bind 127.0.0.1 2>&1\n`
    );

    const tunnel = await openPortForwardTunnel({ transport: 'k8s', proxy, remotePort });
    try {
      // Poll the forwarded local port until the in-pod server answers. Each
      // fetch is time-bounded so a not-yet-listening pod port can't hang.
      let body = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${tunnel.localPort}/`, {
            signal: AbortSignal.timeout(1000),
          });
          body = await res.text();
          if (body.includes('k8s-portforward-marker')) break;
        } catch {
          // tunnel/server not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // eslint-disable-next-line no-console
      console.log(
        '[smoke] port-forward local port:',
        tunnel.localPort,
        'body:',
        JSON.stringify(body),
        'server output:',
        JSON.stringify(serverOutput.slice(0, 400))
      );
      expect(body).toContain('k8s-portforward-marker');
    } finally {
      await tunnel.close();
      server.write('\x03'); // Ctrl-C the server
      server.kill();
    }
  }, 60_000);

  it('discovers contexts and pods from the kubeconfig', async () => {
    const contexts = listKubeConfigContexts(config.kubeconfigPath);
    // eslint-disable-next-line no-console
    console.log(
      '[smoke] contexts:',
      contexts.map((c) => c.name)
    );
    expect(contexts.some((c) => c.name === config.context)).toBe(true);

    const pods = await listPodsForContext(config.context, config.namespace, config.kubeconfigPath);
    // eslint-disable-next-line no-console
    console.log(
      '[smoke] pods in',
      config.namespace,
      ':',
      pods.map((p) => `${p.name}(${p.phase})`)
    );
    expect(pods.some((p) => p.name === config.podName)).toBe(true);

    // Cluster-wide namespace listing is often RBAC-denied for namespace-scoped
    // users; only assert the shape when permitted.
    try {
      const namespaces = await listNamespacesForContext(config.context, config.kubeconfigPath);
      expect(Array.isArray(namespaces)).toBe(true);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log('[smoke] namespace listing denied (expected for scoped users):', String(error));
    }
  }, 30_000);
});
