import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Stats } from '@/lib/agent/stats';
import { formatDuration, formatLatency } from '@/lib/format';

interface Metric {
  name: string;
  reading: string;
  /** 0–1 of the platform's budget used; omitted for counts. */
  meter?: number;
}

/** The budgets the platform imposes, and how much of each the agent uses on average. */
function metrics(s: Stats): Metric[] {
  const { latency: l, totals: t } = s;
  const WINDOW = 30_000;
  const CAP = 180_000;
  return [
    {
      name: 'Avg hang-up to record',
      reading: l.close_to_submitted_ms.n ? formatLatency(l.close_to_submitted_ms.avg) : '—',
      meter: (l.close_to_submitted_ms.avg ?? 0) / WINDOW,
    },
    {
      name: 'Avg time per call',
      reading: l.call_ms.n ? formatDuration(l.call_ms.avg) : '—',
      meter: (l.call_ms.avg ?? 0) / CAP,
    },
    {
      name: 'Avg decider time',
      reading: l.decider_ms.n ? formatLatency(l.decider_ms.avg) : '—',
      meter: (l.decider_ms.avg ?? 0) / WINDOW,
    },
    {
      name: 'Avg time to answer',
      reading: l.session_start_ms.n ? formatLatency(l.session_start_ms.avg) : '—',
      meter: (l.session_start_ms.avg ?? 0) / 2_000,
    },
    {
      name: 'Calls using fallback decision',
      reading: `${t.floor_used} of ${t.ended}`,
    },
    {
      name: 'Calls without a record',
      reading: `${t.without_record} of ${t.ended}`,
    },
  ];
}

export function PipelineHealthCard({ stats, className }: { stats: Stats; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>Pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-x-8 lg:grid-cols-2">
          {metrics(stats).map((m) => (
            <li key={m.name} className="space-y-2 border-t py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm font-medium">{m.name}</p>
                <span className="tabular shrink-0 text-sm">{m.reading}</span>
              </div>
              {m.meter !== undefined && (
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full bg-neutral-400 transition-[width] duration-500"
                    style={{ width: `${Math.min(1, m.meter) * 100}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
