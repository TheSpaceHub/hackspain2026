import { History, Radio, ShieldCheck, Timer, Unplug } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/calls/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { useStats } from '@/hooks/use-stats';
import { callStatus } from '@/lib/agent/model';
import { RANGES, type RangeId } from '@/lib/agent/stats';
import { formatClock, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KpiTile } from './kpi-tile';
import { OutcomesCard } from './outcomes-card';
import { PipelineHealthCard } from './pipeline-health-card';
import { RecentCallsCard } from './recent-calls-card';
import { VolumeCard } from './volume-card';

interface OverviewViewProps {
  feed: CallFeed;
  onOpenCall: (id: string) => void;
  onViewFinished: () => void;
}

/**
 * The landing page: the four numbers that say how the agent is doing, then the
 * shape behind them. One range filter scopes everything below it; "in progress"
 * is the exception, because it is now by definition.
 */
export function OverviewView({ feed, onOpenCall, onViewFinished }: OverviewViewProps) {
  const [rangeId, setRangeId] = useState<RangeId>('today');
  const range = RANGES.find((r) => r.id === rangeId)!;
  const now = useNow(5_000);
  const { stats, updatedAt, refreshing, error, stale } = useStats(range, feed.calls);

  const inProgress = useMemo(() => feed.calls.filter((c) => callStatus(c, now) === 'live').length, [feed.calls, now]);

  const trends = useMemo(() => {
    const series = stats?.series ?? [];
    let running = 0;
    return {
      started: series.map((b) => b.calls),
      finished: series.map((b) => (running += b.calls)),
      recordRate: series.map((b) => (b.calls ? b.with_record / b.calls : null)),
      length: series.map((b) => b.call_ms_p50),
    };
  }, [stats]);

  if (!feed.connected && !stats) {
    return (
      <EmptyState icon={Unplug} title="Can’t reach the agent">
        The console reads the agent on :7860. Start it with <code className="font-mono text-xs">pnpm start:local</code>.
      </EmptyState>
    );
  }

  const t = stats?.totals;
  const rate = t && t.ended ? Math.round((t.with_record / t.ended) * 100) : null;

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-4 pb-4">
      <div className="flex items-center justify-between gap-4">
        <Tabs value={rangeId} onValueChange={(v) => setRangeId(v as RangeId)}>
          <TabsList aria-label="Time range">
            {RANGES.map((r) => (
              <TabsTrigger key={r.id} value={r.id} className="px-3">
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', error ? 'bg-red-500' : refreshing ? 'animate-pulse bg-brand-500' : 'bg-neutral-300')} />
          {error
            ? 'Stats unavailable — showing the last good numbers'
            : updatedAt
              ? `Updated ${formatClock(new Date(updatedAt).toISOString(), true)}`
              : 'Loading…'}
        </p>
      </div>

      {/* Held at reduced opacity while a new range loads — no skeleton, no jump. */}
      <div className={cn('space-y-4 transition-opacity', stale && 'opacity-60')}>
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            icon={Radio}
            label="Calls in progress"
            value={inProgress}
            hint={inProgress ? 'On the line right now' : 'The line is quiet'}
            pulse={inProgress > 0}
            trend={trends.started}
            trendLabel={`Calls started ${range.phrase}`}
          />
          <KpiTile
            icon={History}
            label="Finished calls"
            value={t ? t.ended : '—'}
            hint={t ? `${range.phrase[0]!.toUpperCase()}${range.phrase.slice(1)}` : ' '}
            trend={trends.finished}
            trendLabel={`Calls finished, cumulative ${range.phrase}`}
          />
          <KpiTile
            icon={ShieldCheck}
            label="Record rate"
            value={rate === null ? '—' : `${rate}%`}
            hint={t ? (t.without_record ? `${t.without_record} ended with no record` : 'Every finished call left a record') : ' '}
            trend={trends.recordRate}
            trendLabel="Share of calls with an accepted submission"
          />
          <KpiTile
            icon={Timer}
            label="Median call"
            value={stats?.latency.call_ms.p50 != null ? formatDuration(stats.latency.call_ms.p50) : '—'}
            hint={stats?.latency.call_ms.p95 != null ? `p95 ${formatDuration(stats.latency.call_ms.p95)} · cut at 3:00` : 'Cut at 3:00'}
            trend={trends.length}
            trendLabel="Median call length per bucket"
          />
        </div>

        {stats && (
          <>
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <VolumeCard stats={stats} range={range} />
              </div>
              <OutcomesCard stats={stats} range={range} />
            </div>
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <RecentCallsCard calls={feed.calls} now={now} onOpen={onOpenCall} onViewAll={onViewFinished} />
              </div>
              <PipelineHealthCard stats={stats} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
