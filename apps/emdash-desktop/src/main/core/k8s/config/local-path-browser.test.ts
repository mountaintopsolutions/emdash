import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browseLocalPath, expandTilde } from './local-path-browser';

describe('expandTilde', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('expands a leading ~/ to a home-relative path', () => {
    expect(expandTilde('~/.kube/config')).toBe(path.join(os.homedir(), '.kube/config'));
  });

  it('leaves absolute and relative paths untouched', () => {
    expect(expandTilde('/etc/hosts')).toBe('/etc/hosts');
    expect(expandTilde('./local')).toBe('./local');
  });
});

describe('browseLocalPath', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-browse-'));
    await fs.mkdir(path.join(root, '.kube'));
    await fs.mkdir(path.join(root, 'apps'));
    await fs.writeFile(path.join(root, 'config'), 'x');
    await fs.writeFile(path.join(root, 'README.md'), 'x');
    await fs.writeFile(path.join(root, '.kube', 'config'), 'x');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists a directory with folders first and tags entry types', async () => {
    const { dir, entries } = await browseLocalPath(root);
    expect(dir).toBe(root);
    // Directories (including dotfiles) sort before files.
    expect(entries.slice(0, 2).map((e) => e.name)).toEqual(['.kube', 'apps']);
    expect(entries.every((e) => (e.type === 'dir') === ['.kube', 'apps'].includes(e.name))).toBe(
      true
    );
    expect(entries.find((e) => e.name === 'config')?.path).toBe(path.join(root, 'config'));
  });

  it('lists the directory contents when the input ends with a separator', async () => {
    const { entries } = await browseLocalPath(`${root}/`);
    expect(entries.map((e) => e.name)).toContain('config');
  });

  it('filters by the trailing segment as a case-insensitive prefix', async () => {
    const { entries } = await browseLocalPath(path.join(root, 'RE'));
    expect(entries.map((e) => e.name)).toEqual(['README.md']);
  });

  it('drills into a directory chosen from a prior listing', async () => {
    const { entries } = await browseLocalPath(path.join(root, '.kube') + '/');
    expect(entries.map((e) => e.name)).toEqual(['config']);
  });

  it('returns an empty listing for an unreadable directory instead of throwing', async () => {
    const { entries } = await browseLocalPath(path.join(root, 'does-not-exist', 'deeper') + '/');
    expect(entries).toEqual([]);
  });
});
