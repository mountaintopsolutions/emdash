import path from 'node:path';
import {
  type FileEnumeration,
  type FileError,
  type FileGlob,
  type FileGlobOptions,
  type FileStat,
  type IFileSystem,
  type ReadBytesResult,
  type ReadFileOptions,
  type ReadTextResult,
  type WriteFileResult,
} from '@emdash/core/files';
import { err, ok, type Result } from '@emdash/shared';
import type { KubeClientProxy } from '@main/core/k8s/lifecycle/kube-client-proxy';
import { quoteShellArg } from '@main/utils/shellEscape';
import { K8sFileSystem } from './k8s-legacy-fs';
import { normalizeRemoteAbsolutePath } from './k8s-paths';
import { enumerateRemoteK8sWorkspace } from './k8s-remote-enumerate';
import { FileSystemError, FileSystemErrorCodes, type FileEntry } from './ssh-legacy-fs-types';

const DEFAULT_MAX_BYTES = 200 * 1024;
const MAX_READ_BYTES = 100 * 1024 * 1024;

/**
 * Kubernetes IFileSystem adapter.
 *
 * Mirrors LegacySshFileSystem: wraps the thin K8sFileSystem (LegacySshFileOperations)
 * and exposes the @emdash/core/files IFileSystem surface consumed by the file
 * runtime / file tree. The k8s implementation is simpler than SSH's because
 * K8sFileSystem.read already performs size-bounded binary reads via the proxy's
 * readFileBytes — there is no SFTP handle to manage.
 */
export class LegacyK8sFileSystem implements IFileSystem {
  private readonly legacy: K8sFileSystem;

  constructor(private readonly proxy: KubeClientProxy) {
    this.legacy = new K8sFileSystem(proxy, '/');
  }

  async readText(
    absPath: string,
    options?: ReadFileOptions
  ): Promise<Result<ReadTextResult, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      return ok(await this.legacy.read(normalized.data, options?.maxBytes));
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async readBytes(
    absPath: string,
    options: ReadFileOptions = {}
  ): Promise<Result<ReadBytesResult, FileError>> {
    const resolved = normalizeRemoteAbsolutePath(absPath);
    if (!resolved.success) return resolved;

    try {
      const entry = await this.legacy.stat(resolved.data);
      if (!entry) {
        return err({
          type: 'fs-error',
          path: absPath,
          message: `File or directory not found: ${absPath}`,
          code: FileSystemErrorCodes.NOT_FOUND,
        });
      }
      if (entry.type === 'dir') {
        return err({
          type: 'fs-error',
          path: absPath,
          message: `Path is a directory: ${absPath}`,
          code: FileSystemErrorCodes.IS_DIRECTORY,
        });
      }

      const fileSize = entry.size ?? 0;
      const readSize = Math.min(fileSize, normalizeMaxBytes(options.maxBytes));
      if (readSize === 0) {
        return ok({
          bytes: new Uint8Array(),
          truncated: fileSize > readSize,
          totalSize: fileSize,
        });
      }

      // readFileBytes caps the transfer at readSize (M2) and returns raw bytes.
      const buffer = await this.proxy.readFileBytes(resolved.data, readSize);
      return ok({
        bytes: new Uint8Array(buffer.subarray(0, readSize)),
        truncated: fileSize > readSize,
        totalSize: fileSize,
      });
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async writeText(absPath: string, content: string): Promise<Result<WriteFileResult, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      const result = await this.legacy.write(normalized.data, content);
      if (!result.success) {
        return err({
          type: 'fs-error',
          path: absPath,
          message: result.error ?? `Failed to write file: ${absPath}`,
        });
      }
      return ok({ bytesWritten: result.bytesWritten });
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async writeBytes(
    absPath: string,
    bytes: Uint8Array
  ): Promise<Result<WriteFileResult, FileError>> {
    const resolved = normalizeRemoteAbsolutePath(absPath);
    if (!resolved.success) return resolved;

    try {
      const parentDir = path.posix.dirname(resolved.data);
      if (parentDir && parentDir !== '/') {
        await this.legacy.mkdir(parentDir, { recursive: true });
      }
      // Stream raw bytes to the pod via a non-TTY exec session so binary content
      // is preserved (K8sFileSystem.write goes through UTF-8 string conversion).
      await this.proxy.writeFileBytes(`cat > ${quoteShellArg(resolved.data)}`, Buffer.from(bytes));
      return ok({ bytesWritten: bytes.byteLength });
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async stat(absPath: string): Promise<Result<FileStat, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      const entry = await this.legacy.stat(normalized.data);
      if (!entry) {
        return err({
          type: 'fs-error',
          path: absPath,
          message: `File or directory not found: ${absPath}`,
          code: FileSystemErrorCodes.NOT_FOUND,
        });
      }
      return ok(toFileStat(entry));
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async exists(absPath: string): Promise<Result<boolean, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      return ok(await this.legacy.exists(normalized.data));
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async mkdir(
    absPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<Result<void, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;
    if (normalized.data === '/') return ok<void>();

    try {
      await this.legacy.mkdir(normalized.data, options);
      return ok<void>();
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async remove(
    absPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<Result<void, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      const result = await this.legacy.remove(normalized.data, options);
      if (!result.success) {
        return err({
          type: 'fs-error',
          path: absPath,
          message: result.error ?? `Failed to remove file: ${absPath}`,
        });
      }
      return ok<void>();
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async realPath(absPath: string): Promise<Result<string, FileError>> {
    const normalized = normalizeRemoteAbsolutePath(absPath);
    if (!normalized.success) return normalized;

    try {
      return ok(await this.legacy.realPath(normalized.data));
    } catch (error) {
      return err(toFileError(error, absPath));
    }
  }

  async copyFile(src: string, dest: string): Promise<Result<void, FileError>> {
    const normalizedSrc = normalizeRemoteAbsolutePath(src);
    if (!normalizedSrc.success) return normalizedSrc;
    const normalizedDest = normalizeRemoteAbsolutePath(dest);
    if (!normalizedDest.success) return normalizedDest;

    try {
      await this.legacy.copyFile(normalizedSrc.data, normalizedDest.data);
      return ok<void>();
    } catch (error) {
      return err(toFileError(error, dest));
    }
  }

  glob(patterns: string[], options: FileGlobOptions): Result<FileGlob, FileError> {
    const validated = validateGlobPatterns(patterns);
    if (!validated.success) return validated;
    const cwd = normalizeRemoteAbsolutePath(options.cwd);
    if (!cwd.success) return cwd;
    return ok(this.globPaths(validated.data, options));
  }

  enumerate(rootPath: string): Result<FileEnumeration, FileError> {
    const normalizedRoot = normalizeRemoteAbsolutePath(rootPath);
    if (!normalizedRoot.success) return normalizedRoot;
    return ok(enumerateRemoteK8sWorkspace(this.proxy, normalizedRoot.data));
  }

  private async *globPaths(patterns: string[], options: FileGlobOptions): FileGlob {
    const cwd = normalizeRemoteAbsolutePath(options.cwd);
    if (!cwd.success) return;

    const seen = new Set<string>();
    for (const pattern of patterns) {
      const matches = await this.legacy.glob(pattern, {
        cwd: cwd.data,
        dot: options.dot ?? false,
      });
      for (const match of matches) {
        const normalized = normalizeRemoteAbsolutePath(path.posix.resolve(cwd.data, match));
        if (!normalized.success || seen.has(normalized.data)) continue;
        seen.add(normalized.data);
        yield normalized.data;
      }
    }
  }
}

function toFileStat(entry: FileEntry): FileStat {
  return {
    path: entry.path,
    type: entry.type === 'dir' ? 'directory' : 'file',
    size: entry.size ?? 0,
    mtime: entry.mtime ?? new Date(0),
    ctime: entry.ctime ?? new Date(0),
    mode: entry.mode ?? 0,
  };
}

function toFileError(error: unknown, absPath: string): FileError {
  if (error instanceof FileSystemError) {
    return { type: 'fs-error', path: absPath, message: error.message, code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'fs-error',
    path: absPath,
    message,
  };
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return 0;
  return Math.min(Math.floor(maxBytes), MAX_READ_BYTES);
}

function validateGlobPatterns(patterns: string[]): Result<string[], FileError> {
  if (patterns.length === 0) {
    return err({
      type: 'invalid-path',
      path: '',
      message: 'At least one glob pattern is required',
    });
  }

  const normalizedPatterns: string[] = [];
  for (const pattern of patterns) {
    if (!pattern) {
      return err({
        type: 'invalid-path',
        path: pattern,
        message: 'Glob pattern must not be empty',
      });
    }
    if (pattern.includes('\0')) {
      return err({ type: 'invalid-path', path: pattern, message: 'Path contains a null byte' });
    }
    if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
      return err({
        type: 'invalid-path',
        path: pattern,
        message: 'Absolute paths are not allowed',
      });
    }

    const parts = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.includes('..')) {
      return err({
        type: 'invalid-path',
        path: pattern,
        message: 'Parent path segments are not allowed',
      });
    }
    normalizedPatterns.push(pattern.replace(/\\/g, '/'));
  }
  return ok(normalizedPatterns);
}
