import { MessagesSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { callStatus } from '@/lib/agent/model';
import { Card } from '@/components/ui/card';
import { CallDetail } from './call-detail';
import { CallList } from './call-list';
import { EmptyState } from './empty-state';

interface FinishedCallsViewProps {
  feed: CallFeed;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * Master–detail over every call that is no longer live. The list carries counts
 * only; opening a call pulls its transcript and submissions once.
 */
export function FinishedCallsView({ feed, selectedId, onSelect: select }: FinishedCallsViewProps) {
  const now = useNow();
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<string | null>(null);

  const finished = useMemo(() => feed.calls.filter((c) => callStatus(c, now) !== 'live'), [feed.calls, now]);
  const selected = selectedId ? feed.calls.find((c) => c.id === selectedId) : undefined;

  const { loadCall, connected } = feed;

  // A reconnect means the agent may have restarted mid-load: fetch the open call again.
  useEffect(() => {
    if (connected) setLoaded(new Set());
  }, [connected]);

  useEffect(() => {
    if (!selectedId || !connected || loaded.has(selectedId)) return;
    let cancelled = false;
    setLoading(selectedId);
    loadCall(selectedId)
      .then(() => {
        // Only a load that worked counts; a failed one is retried on the next reconnect.
        if (!cancelled) setLoaded((prev) => new Set(prev).add(selectedId));
      })
      .catch((err: unknown) => console.warn('[calls] could not load', selectedId, err))
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, connected, loaded, loadCall]);

  return (
    <div className="grid h-full grid-cols-[360px_1fr] gap-4 p-4">
      <Card size="sm" className="min-h-0 gap-0 py-0">
        <CallList calls={finished} selectedId={selectedId} onSelect={select} now={now} />
      </Card>

      <Card size="sm" className="min-h-0 gap-0 py-0">
        {selected ? (
          <CallDetail call={selected} loading={loading === selected.id} now={now} />
        ) : selectedId && loading === selectedId ? null : selectedId ? (
          <EmptyState icon={MessagesSquare} title="Call not found">
            The agent has no call with this id. It may have been cleared from its store.
          </EmptyState>
        ) : (
          <EmptyState icon={MessagesSquare} title="Select a call">
            Pick a call on the left to read the conversation and what the agent recorded.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
