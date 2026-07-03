/**
 * Kubernetes FileSystem implementation.
 *
 * Unlike the SSH filesystem, a pod has no SFTP service, so every operation is
 * implemented over `kubectl exec`-style shell commands through the
 * KubeClientProxy (cat / printf / ls / stat / find / grep / mkdir -p / rm /
 * cp / realpath), mirroring how SshFileSystem implements operations via exec.
 * Binary reads stream raw bytes through the proxy's dedicated transfer helpers
 * rather than the buffered, UTF-8 `exec()` path which would corrupt non-text
 * content.
 *
 * Mirrors SshFileSystem (ssh-legacy-fs.ts): implements LegacySshFileOperations,
 * the thin provider kept for non-tree workspace file operations (read/write/
 * glob/copy/config watches/project setup). File-tree reads, scopes, and deltas
 * live in @emdash/core/files and are exposed through the files runtime.
 */

import { buildRemoteShellCommand } from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { quoteShellArg } from '@main/utils/shellEscape';
import type { FileWatchEvent } from '@shared/core/fs/fs';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileEntry,
  type FileListResult,
  type FileWatcher,
  type LegacySshFileOperations,
  type ListOptions,
  type ReadResult,
  type WriteResult,
} from './ssh-legacy-fs-types';

/**
 * Maximum file size for reading (100MB to prevent memory issues)
 */
const MAX_READ_SIZE = 100 * 1024 * 1024;

/**
 * Default max bytes for read operations
 */
const DEFAULT_MAX_BYTES = 200 * 1024;

function fileEntryMetadataChanged(prev: FileEntry, next: FileEntry): boolean {
  return (
    prev.type !== next.type ||
    prev.size !== next.size ||
    prev.mode !== next.mode ||
    prev.mtime?.getTime() !== next.mtime?.getTime()
  );
}

/**
 * K8sFileSystem implements LegacySshFileOperations over pod exec.
 * Provides path traversal protection and POSIX-shell-based operations.
 * Constructed in parallel to SshFileSystem: `new K8sFileSystem(proxy, rootPath)`.
 */
export class K8sFileSystem implements LegacySshFileOperations {
  private readonly remotePath: string;

  constructor(
    private readonly proxy: KubeClientProxy,
    remotePath: string
  ) {
    if (!remotePath) {
      throw new FileSystemError('Remote path is required', FileSystemErrorCodes.INVALID_PATH);
    }
    // Normalize remote path to use forward slashes
    this.remotePath = remotePath.replace(/\\/g, '/');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Run a shell command in the pod with the captured remote shell profile
   * applied (mirrors SshFileSystem.exec). Returns trimmed stdout/stderr and the
   * exit code.
   */
  private async exec(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const profile = await this.proxy.getRemoteShellProfile();
    const full = buildRemoteShellCommand(profile, command);
    const result = await this.proxy.exec(full);
    return {
      stdout: result.stdout.replace(/\s+$/, ''),
      stderr: result.stderr.replace(/\s+$/, ''),
      exitCode: result.exitCode,
    };
  }

  // ─── LegacySshFileOperations ───────────────────────────────────────────────

  /**
   * List directory contents via `find -maxdepth 1` over exec.
   *
   * Uses a single `find -printf` invocation that prints, per entry, a record of
   * type|size|mtime|mode|name so the whole listing comes back in one round-trip.
   */
  async list(path: string = '', options?: ListOptions): Promise<FileListResult> {
    const startTime = Date.now();
    const fullPath = this.resolveRemotePath(path);

    // %y=type(f/d/l/...), %s=size, %T@=mtime epoch, %m=octal mode, %f=basename.
    // -mindepth 1 skips the directory itself; -maxdepth 1 keeps it shallow.
    const command =
      `find ${quoteShellArg(fullPath)} -mindepth 1 -maxdepth 1 ` +
      `-printf '%y\\t%s\\t%T@\\t%m\\t%f\\n' 2>/dev/null`;

    const result = await this.exec(command);
    if (result.exitCode !== 0 && !result.stdout) {
      // find returns non-zero when the directory is missing or unreadable.
      const exists = await this.stat(path);
      if (!exists) {
        throw new FileSystemError(
          `File or directory not found: ${fullPath}`,
          FileSystemErrorCodes.NOT_FOUND,
          path
        );
      }
    }

    const entries: FileEntry[] = [];
    const seen = new Set<string>();

    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 5) continue;
      const [typeChar, sizeStr, mtimeStr, modeStr] = parts;
      // The basename may legitimately contain tabs; rejoin the remainder.
      const name = parts.slice(4).join('\t');
      if (!name) continue;

      if (!options?.includeHidden && name.startsWith('.')) {
        continue;
      }

      if (options?.filter) {
        const filterRegex = new RegExp(options.filter);
        if (!filterRegex.test(name)) {
          continue;
        }
      }

      const entryPath = this.relativePath(`${fullPath}/${name}`);
      if (seen.has(entryPath)) continue;
      seen.add(entryPath);

      const mtimeSeconds = Number.parseFloat(mtimeStr);
      const size = Number.parseInt(sizeStr, 10);
      const mode = Number.parseInt(modeStr, 8);

      entries.push({
        path: entryPath,
        type: typeChar === 'd' ? 'dir' : 'file',
        size: Number.isNaN(size) ? undefined : size,
        mtime: Number.isNaN(mtimeSeconds) ? undefined : new Date(mtimeSeconds * 1000),
        mode: Number.isNaN(mode) ? undefined : mode,
      });
    }

    // Sort entries: directories first, then files, both alphabetically
    entries.sort((a, b) => {
      if (a.type === b.type) {
        return a.path.localeCompare(b.path);
      }
      return a.type === 'dir' ? -1 : 1;
    });

    let resultEntries = entries;
    let truncated = false;
    let truncateReason: 'maxEntries' | 'timeBudget' | undefined;

    if (options?.maxEntries && entries.length > options.maxEntries) {
      resultEntries = entries.slice(0, options.maxEntries);
      truncated = true;
      truncateReason = 'maxEntries';
    }

    const durationMs = Date.now() - startTime;
    if (options?.timeBudgetMs && durationMs > options.timeBudgetMs) {
      truncated = true;
      truncateReason = 'timeBudget';
    }

    return {
      entries: resultEntries,
      total: entries.length,
      truncated,
      truncateReason,
      durationMs,
    };
  }

  /**
   * Read file contents. Reads raw bytes through the proxy's binary transfer
   * path (size-capped), then decodes as UTF-8, so the maxBytes truncation
   * matches the SSH implementation's byte semantics.
   */
  async read(path: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<ReadResult> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new FileSystemError(
        `File or directory not found: ${path}`,
        FileSystemErrorCodes.NOT_FOUND,
        path
      );
    }
    if (entry.type === 'dir') {
      throw new FileSystemError(
        `Path is a directory: ${path}`,
        FileSystemErrorCodes.IS_DIRECTORY,
        path
      );
    }

    const fileSize = entry.size ?? 0;
    const readSize = Math.min(fileSize, maxBytes, MAX_READ_SIZE);
    if (readSize === 0) {
      return { content: '', truncated: false, totalSize: fileSize };
    }

    const fullPath = this.resolveRemotePath(path);
    const buffer = await this.proxy.readFileBytes(fullPath, readSize);
    const slice = buffer.subarray(0, readSize);

    return {
      content: slice.toString('utf-8'),
      truncated: fileSize > maxBytes,
      totalSize: fileSize,
    };
  }

  /**
   * Write file contents. Creates parent directories recursively, then streams
   * the bytes into the file through the proxy's stdin transfer path.
   */
  async write(path: string, content: string): Promise<WriteResult> {
    const fullPath = this.resolveRemotePath(path);

    const lastSlash = fullPath.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentDir = fullPath.substring(0, lastSlash);
      await this.ensureRemoteDir(parentDir);
    }

    const buffer = Buffer.from(content, 'utf-8');
    // `cat > '<file>'` truncates+writes; stdin is supplied by the proxy.
    await this.proxy.writeFileBytes(`cat > ${quoteShellArg(fullPath)}`, buffer);

    return { success: true, bytesWritten: buffer.length };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const entry = await this.stat(path);
      return entry !== null;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    const fullPath = this.resolveRemotePath(dirPath);
    if (options?.recursive) {
      await this.ensureRemoteDir(fullPath);
      return;
    }
    const result = await this.exec(`mkdir ${quoteShellArg(fullPath)}`);
    if (result.exitCode !== 0) {
      throw new FileSystemError(
        `Failed to create directory: ${result.stderr || dirPath}`,
        FileSystemErrorCodes.UNKNOWN,
        dirPath
      );
    }
  }

  async realPath(path: string): Promise<string> {
    const fullPath = this.resolveRemotePath(path);
    const result = await this.exec(`realpath ${quoteShellArg(fullPath)}`);
    if (result.exitCode !== 0) {
      throw new Error(`realpath failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async glob(pattern: string, options?: { cwd?: string; dot?: boolean }): Promise<string[]> {
    const cwd = options?.cwd ? this.resolveRemotePath(options.cwd) : this.remotePath;
    const dotSetup = options?.dot ? 'shopt -s dotglob;' : '';
    const command = `${dotSetup} shopt -s nullglob; cd ${quoteShellArg(cwd)} && printf '%s\\n' ${pattern}`;
    try {
      const result = await this.exec(command);
      if (result.exitCode !== 0) return [];
      return result.stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const fullSrc = this.resolveRemotePath(src);
    const fullDest = this.resolveRemotePath(dest);
    const result = await this.exec(`cp ${quoteShellArg(fullSrc)} ${quoteShellArg(fullDest)}`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to copy file: ${result.stderr}`);
    }
  }

  /**
   * Get file/directory metadata via `stat`. Returns null when the path does not
   * exist. Uses GNU/BusyBox `stat -c` format; mtime is reported in epoch seconds.
   */
  async stat(path: string): Promise<FileEntry | null> {
    const fullPath = this.resolveRemotePath(path);
    // %F=human type, %s=size, %Y=mtime epoch, %f=raw mode (hex). %f includes the
    // file-type bits, so we mask them off and keep the permission bits.
    // NOTE: `stat -c` does NOT interpret backslash escapes (unlike `find -printf`),
    // so a literal `|` delimiter is used rather than `\t`. None of these fields
    // (%F is "directory"/"regular file"/"symbolic link") can contain `|`.
    const command = `stat -c '%F|%s|%Y|%f' ${quoteShellArg(fullPath)} 2>/dev/null`;
    const result = await this.exec(command);
    if (result.exitCode !== 0 || !result.stdout) {
      return null;
    }

    const [typeDesc, sizeStr, mtimeStr, modeHex] = result.stdout.split('|');
    const size = Number.parseInt(sizeStr, 10);
    const mtimeSeconds = Number.parseInt(mtimeStr, 10);
    const rawMode = Number.parseInt(modeHex, 16);
    const mode = Number.isNaN(rawMode) ? undefined : rawMode & 0o7777;

    return {
      path,
      type: typeDesc === 'directory' ? 'dir' : 'file',
      size: Number.isNaN(size) ? undefined : size,
      mtime: Number.isNaN(mtimeSeconds) ? undefined : new Date(mtimeSeconds * 1000),
      mode,
    };
  }

  /**
   * Remove a file or directory via `rm`. Directories require `recursive: true`.
   */
  async remove(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const fullPath = this.resolveRemotePath(path);

    try {
      const entry = await this.stat(path);
      if (!entry) {
        return { success: false, error: `File not found: ${path}` };
      }

      if (entry.type === 'dir' && !options?.recursive) {
        return { success: false, error: `Path is a directory: ${path}` };
      }

      const command = options?.recursive
        ? `rm -rf ${quoteShellArg(fullPath)}`
        : `rm -f ${quoteShellArg(fullPath)}`;
      const result = await this.exec(command);

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'Failed to remove path' };
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  // ─── Polling watch (mirrors SshFileSystem.watch) ───────────────────────────

  watch(
    callback: (events: FileWatchEvent[]) => void,
    options: { debounceMs?: number } = {}
  ): FileWatcher {
    const interval = options.debounceMs ?? 4000;
    let watched: string[] = [];
    const snapshots = new Map<string, Map<string, FileEntry>>();

    const poll = async () => {
      for (const dirPath of watched) {
        let result: FileListResult | null = null;
        try {
          result = await this.list(dirPath, { includeHidden: true });
        } catch {
          continue;
        }

        const currMap = new Map(result.entries.map((e) => [e.path, e]));
        const prevMap = snapshots.get(dirPath);
        snapshots.set(dirPath, currMap);

        if (!prevMap) continue;

        const evts: FileWatchEvent[] = [];
        for (const [p, e] of currMap) {
          const prev = prevMap.get(p);
          if (!prev)
            evts.push({
              type: 'create',
              entryType: e.type === 'dir' ? 'directory' : 'file',
              path: p,
            });
          else if (fileEntryMetadataChanged(prev, e))
            evts.push({
              type: 'modify',
              entryType: e.type === 'dir' ? 'directory' : 'file',
              path: p,
            });
        }
        for (const [p, e] of prevMap) {
          if (!currMap.has(p))
            evts.push({
              type: 'delete',
              entryType: e.type === 'dir' ? 'directory' : 'file',
              path: p,
            });
        }
        if (evts.length) callback(evts);
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, interval);

    return {
      update(paths: string[]) {
        watched = paths;
        for (const p of snapshots.keys()) {
          if (!paths.includes(p)) snapshots.delete(p);
        }
      },
      close() {
        clearInterval(timer);
      },
    };
  }

  // ─── Private utilities ────────────────────────────────────────────────────

  /**
   * Build absolute remote path from relative path.
   * Provides path traversal protection. (Mirrors SshFileSystem.)
   */
  private resolveRemotePath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');

    if (normalized.startsWith('/')) {
      const resolved = this.normalizePosixPath(normalized);
      if (!this.isWithinBase(resolved)) {
        throw new FileSystemError(
          'Path traversal detected: path escapes base directory',
          FileSystemErrorCodes.PATH_ESCAPE,
          relPath
        );
      }
      return resolved;
    }

    const joined = `${this.remotePath}/${normalized}`.replace(/\/+/g, '/');
    const fullPath = this.normalizePosixPath(joined);

    if (!this.isWithinBase(fullPath)) {
      throw new FileSystemError(
        'Path traversal detected: path escapes base directory',
        FileSystemErrorCodes.PATH_ESCAPE,
        relPath
      );
    }

    return fullPath;
  }

  /** Remove single-dot segments from a POSIX path (e.g. /a/./b → /a/b). */
  private normalizePosixPath(p: string): string {
    const parts = p.split('/');
    const out: string[] = [];
    for (const seg of parts) {
      if (seg === '.') continue;
      out.push(seg);
    }
    return out.join('/').replace(/\/+/g, '/') || '/';
  }

  private isWithinBase(fullPath: string): boolean {
    const normalizedPath = fullPath.replace(/\/+/g, '/').replace(/\/$/, '');
    const normalizedBase = this.remotePath.replace(/\/+/g, '/').replace(/\/$/, '');
    return normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`);
  }

  private relativePath(fullPath: string): string {
    const normalized = fullPath.replace(/\\/g, '/');
    const normalizedBase = this.remotePath.replace(/\\/g, '/');

    if (normalized === normalizedBase) {
      return '';
    }

    const prefix = `${normalizedBase}/`;
    if (normalized.startsWith(prefix)) {
      return normalized.substring(prefix.length);
    }

    return normalized;
  }

  /**
   * Recursively ensure a remote directory exists via `mkdir -p`.
   */
  private async ensureRemoteDir(dirPath: string): Promise<void> {
    const result = await this.exec(`mkdir -p ${quoteShellArg(dirPath)}`);
    if (result.exitCode !== 0) {
      throw new FileSystemError(
        `Failed to create directory: ${result.stderr || dirPath}`,
        FileSystemErrorCodes.UNKNOWN,
        dirPath
      );
    }
  }
}

// Re-export the types consumers expect from this module family.
export { FileSystemError, FileSystemErrorCodes } from './ssh-legacy-fs-types';
export type {
  FileEntry,
  FileListResult,
  FileWatcher,
  LegacySshFileOperations,
  ListOptions,
  ReadResult,
  WriteResult,
} from './ssh-legacy-fs-types';
