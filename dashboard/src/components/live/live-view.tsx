import { Radio, Unplug } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '@/components/calls/empty-state';
import { Card } from '@/components/ui/card';
import type { CallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { wallState } from '@/lib/live';
import { LiveCallCard } from './live-call-card';
import { LiveCallPanel } from './live-call-panel';

interface LiveViewProps {
  feed: CallFeed;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenFinished: (id: string) => void;
}

/**
 * Every call in flight, as it happens — the wall a Run All's ten sockets land on.
 * Cards keep their place (oldest first) so nothing jumps while you read it.
 */
export function LiveView({ feed, selectedId, onSelect, onOpenFinished }: LiveViewProps) {
  // A second is the grain of the timers on screen.
  const now = useNow(1_000);

  const wall = useMemo(
    () =>
      feed.calls
        .flatMap((call) => {
          const state = wallState(call, now);
          return state ? [{ call, state }] : [];
        })
        .sort((a, b) => Date.parse(a.call.startedAt) - Date.parse(b.call.startedAt)),
    [feed.calls, now],
  );
  const inProgress = wall.filter((w) => w.state === 'live').length;
  const justEnded = wall.length - inProgress;
  const selected = selectedId ? feed.calls.find((c) => c.id === selectedId) : undefined;

  return (
    <div className="flex h-full gap-4 px-4 pb-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="tabular text-sm">
            <span className="font-semibold">{inProgress}</span>
            <span className="text-muted-foreground"> in progress</span>
            {justEnded > 0 && (
              <>
                <span className="text-muted-foreground"> · </span>
                <span className="font-semibold">{justEnded}</span>
                <span className="text-muted-foreground"> just ended</span>
              </>
            )}
          </p>
          <span className="text-xs text-muted-foreground">Ended calls stay here for 20 s, then move to Finished</span>
        </div>

        {/* Inset so card shadows and the selection ring are not clipped by the scroller. */}
        <div className="-m-2 min-h-0 flex-1 overflow-y-auto p-2">
          {!feed.connected ? (
            <EmptyState icon={Unplug} title="Can’t reach the agent">
              The console listens to the agent on :7860. Start it with <code className="font-mono text-xs">pnpm start:local</code>.
            </EmptyState>
          ) : wall.length === 0 ? (
            <EmptyState icon={Radio} title="No calls in progress">
              Calls appear here the moment the agent picks up. Make one with{' '}
              <code className="font-mono text-xs">pnpm harness:local -- --scenario all</code>.
            </EmptyState>
          ) : (
            <div className="@container pb-1">
              <div className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
                {wall.map(({ call, state }) => (
                  <LiveCallCard
                    key={call.id}
                    call={call}
                    state={state}
                    selected={call.id === selectedId}
                    onSelect={() => onSelect(call.id === selectedId ? null : call.id)}
                    now={now}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <Card size="sm" className="w-[460px] shrink-0 gap-0 py-0 xl:w-[520px]">
          <LiveCallPanel
            call={selected}
            now={now}
            onClose={() => onSelect(null)}
            onOpenFinished={() => onOpenFinished(selected.id)}
          />
        </Card>
      )}
    </div>
  );
}
