import { StringDecoder } from 'node:string_decoder';
import { buildRemoteShellCommand } from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { quoteShellArg } from '@main/utils/shellEscape';
import { LEGACY_SSH_IGNORED_PATH_SEGMENTS } from './ssh-ignored-paths';
import { isIgnoredRemotePath, toRemoteAbsolutePath } from './k8s-paths';

/**
 * Enumerate all non-ignored files under `rootPath` in the pod, yielding absolute
 * paths. Mirrors ssh-remote-enumerate's enumerateRemoteWorkspace but streams
 * over KubeClientProxy.execStreaming (pod exec WebSocket) instead of an ssh2
 * ClientChannel.
 */
export async function* enumerateRemoteK8sWorkspace(
  proxy: KubeClientProxy,
  rootPath: string
): AsyncIterable<string> {
  for await (const rawPath of execK8sNulFields(proxy, buildRemoteEnumerationCommand(rootPath))) {
    const absPath = toRemoteAbsolutePath(rootPath, rawPath);
    if (isIgnoredRemotePath(rootPath, absPath)) continue;
    yield absPath;
  }
}

export function buildK8sFindPruneExpression(): string {
  const ignoredNames = LEGACY_SSH_IGNORED_PATH_SEGMENTS.map(
    (name) => `-name ${quoteShellArg(name)}`
  ).join(' -o ');
  return ignoredNames ? `\\( ${ignoredNames} \\) -prune -o ` : '';
}

function buildRemoteEnumerationCommand(rootPath: string): string {
  const pruneExpression = buildK8sFindPruneExpression();
  const enumerateScript = `
for p do
  rel=\${p#./}
  [ "$rel" = "." ] && continue
  printf '%s\\0' "$rel"
done
`.trim();

  return [
    `cd ${quoteShellArg(rootPath)} || exit 1`,
    `find . ${pruneExpression}-type f -exec sh -c ${quoteShellArg(enumerateScript)} sh {} +`,
  ].join('\n');
}

/**
 * Run a command on the pod and yield its NUL-separated stdout fields as they
 * arrive. Uses execStreaming so the enumeration streams incrementally rather
 * than buffering the whole workspace listing.
 */
async function* execK8sNulFields(
  proxy: KubeClientProxy,
  command: string
): AsyncIterable<string> {
  const profile = await proxy.getRemoteShellProfile();
  const fullCommand = buildRemoteShellCommand(profile, command);
  const decoder = new StringDecoder('utf8');
  const queue: string[] = [];
  let pending = '';
  let done = false;
  let error: unknown;
  let notify: (() => void) | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });

  const streamPromise = proxy.execStreaming(fullCommand, (chunk: string): boolean => {
    const text = pending + decoder.write(Buffer.from(chunk, 'utf-8'));
    const parts = text.split('\0');
    pending = parts.pop() ?? '';
    queue.push(...parts);
    wake();
    return true;
  });

  void streamPromise
    .then(() => {
      const tail = pending + decoder.end();
      if (tail) queue.push(tail);
      pending = '';
      done = true;
      wake();
    })
    .catch((err: unknown) => {
      error = err;
      done = true;
      wake();
    });

  try {
    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) yield item;
      }
      if (error) throw error;
      if (!done) await waitForEvent();
    }
    if (error) throw error;
  } finally {
    // execStreaming resolves on close; nothing to destroy here. If the caller
    // breaks out early, the underlying WebSocket closes on its own completion.
  }
}
