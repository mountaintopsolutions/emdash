// Local (desktop) filesystem browsing for the kubeconfig path picker. The
// kubeconfig lives on the client machine, so this reads the user's own
// filesystem to drive a folder/file dropdown. It is read-only and best-effort:
// unreadable directories return an empty listing rather than throwing.
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LocalPathEntry, LocalPathListing } from '@shared/kubernetes';

/** Cap entries so a huge directory can't flood the picker. */
const MAX_ENTRIES = 250;

/**
 * Expands a leading `~` / `~/` to the user's home directory. Node's fs (and
 * @kubernetes/client-node's loadFromFile) do not expand `~`, so a path like
 * `~/.kube/config` fails on macOS/Linux without this.
 */
export function expandTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists local files/directories for the kubeconfig path picker.
 *
 * The input is interpreted like a shell path completion:
 * - empty            → list the home directory
 * - an existing dir  → list its contents
 * - ends with a sep  → list that directory
 * - otherwise        → list the parent directory, filtered by the trailing
 *                       segment as a case-insensitive prefix
 *
 * Hidden entries (e.g. `.kube`) are always included since kubeconfigs live in a
 * dotfile directory. Directories sort first and are tagged `type: 'dir'` so the
 * UI can show them as folders rather than selectable files.
 */
export async function browseLocalPath(input: string): Promise<LocalPathListing> {
  const raw = input.trim();
  const expanded = raw ? expandTilde(raw) : os.homedir();
  const endsWithSep = /[/\\]$/.test(raw);

  let dir: string;
  let filter = '';
  if (!raw) {
    dir = os.homedir();
  } else if (endsWithSep) {
    dir = expanded.replace(/[/\\]+$/, '') || path.parse(expanded).root;
  } else if (await isDirectory(expanded)) {
    dir = expanded;
  } else {
    dir = path.dirname(expanded);
    filter = path.basename(expanded);
  }

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, entries: [] };
  }

  const lowerFilter = filter.toLowerCase();
  const entries: LocalPathEntry[] = [];
  for (const dirent of dirents) {
    if (lowerFilter && !dirent.name.toLowerCase().startsWith(lowerFilter)) continue;
    const fullPath = path.join(dir, dirent.name);
    // Resolve symlinks so a linked directory still displays as a folder.
    const isDir = dirent.isSymbolicLink() ? await isDirectory(fullPath) : dirent.isDirectory();
    entries.push({ name: dirent.name, path: fullPath, type: isDir ? 'dir' : 'file' });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { dir, entries: entries.slice(0, MAX_ENTRIES) };
}
