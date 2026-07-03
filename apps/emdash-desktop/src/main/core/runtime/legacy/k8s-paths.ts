/**
 * Kubernetes remote path helpers.
 *
 * Path algebra is transport-neutral (POSIX everywhere), so this module re-uses
 * the SSH implementation rather than duplicating it. Both pods and SSH hosts
 * expose the same POSIX filesystem semantics; only the transport (exec vs SFTP)
 * differs, which is handled by the filesystem/runtime adapters.
 */
export {
  containsRemotePath,
  isIgnoredRemotePath,
  normalizeRemoteAbsolutePath,
  normalizeRemoteRootPath,
  toRemoteAbsolutePath,
} from './ssh-paths';
