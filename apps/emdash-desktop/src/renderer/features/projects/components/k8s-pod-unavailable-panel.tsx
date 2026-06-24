import { Loader2, RefreshCw, Unplug } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';

export const K8sPodUnavailablePanel = observer(function K8sPodUnavailablePanel({
  connectionId,
}: {
  connectionId: string;
}) {
  const connections = appState.k8sConnections;
  const state = connections.stateFor(connectionId);
  const reconnectInfo = connections.reconnectInfoFor(connectionId);
  const isReconnecting = state === 'connecting' || state === 'reconnecting';

  // Re-render on a 500ms tick so the auto-retry countdown updates live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!reconnectInfo) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [reconnectInfo]);

  const secondsUntilRetry = reconnectInfo
    ? Math.max(0, Math.ceil((reconnectInfo.scheduledAt + reconnectInfo.delayMs - now) / 1000))
    : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Unplug className="h-6 w-6 text-foreground-passive" />
        <p className="font-mono text-sm font-medium text-foreground">Pod unavailable</p>
        <p className="text-xs text-foreground-passive">
          The connection to the Kubernetes pod backing this project dropped. emdash keeps several
          exec sessions open per task, so the connection is treated as lost until the pod is
          reachable again. emdash is retrying automatically; you can also reconnect now.
        </p>

        {reconnectInfo && secondsUntilRetry !== null && (
          <p className="text-xs text-foreground-muted">
            Retrying automatically… attempt {reconnectInfo.attempt} (in {secondsUntilRetry}s)
          </p>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => void connections.reconnect(connectionId)}
          disabled={isReconnecting}
        >
          {isReconnecting ? (
            <>
              <Loader2 className="animate-spin" />
              Reconnecting…
            </>
          ) : (
            <>
              <RefreshCw />
              Reconnect
            </>
          )}
        </Button>

        <div className="w-full rounded-md border border-border bg-background-1 p-3 text-left">
          <p className="mb-2 text-xs text-foreground-passive">
            Check the pod status with <span className="font-mono">kubectl</span>:
          </p>
          <pre className="overflow-x-auto rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground">
            {'kubectl get pods -n <namespace>'}
          </pre>
        </div>
        <p className="text-xs text-foreground-muted">
          This view will update automatically once the pod is reachable again.
        </p>
      </div>
    </div>
  );
});
