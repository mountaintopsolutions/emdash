import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { TerminalShellAvailability } from '@shared/terminal-settings';

export const DEFAULT_TERMINAL_SHELL_AVAILABILITY: TerminalShellAvailability[] = [];

export type RemoteShellTarget = { kind: 'ssh' | 'k8s'; connectionId: string };

export function useTerminalShellAvailability(
  remote: RemoteShellTarget | undefined,
  options: { enabled?: boolean } = {}
) {
  const isRemote = Boolean(remote);
  return useQuery({
    queryKey: [
      'terminal-shell-availability',
      remote ? `${remote.kind}:${remote.connectionId}` : 'local',
    ],
    queryFn: () =>
      remote
        ? rpc.terminals.getTerminalShellAvailability({
            kind: remote.kind,
            connectionId: remote.connectionId,
          })
        : rpc.terminals.getTerminalShellAvailability({ kind: 'local' }),
    staleTime: isRemote ? 5_000 : 30_000,
    enabled: options.enabled ?? true,
  });
}
