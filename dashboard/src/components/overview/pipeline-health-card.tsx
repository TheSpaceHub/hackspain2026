import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Stats } from '@/lib/agent/stats';
import { formatDuration, formatLatency } from '@/lib/format';
import { cn } from '@/lib/utils';

type Health = 'good' | 'watch' | 'risk' | 'none';

const STATUS: Record<Health, { label: string; icon: typeof CircleCheck; text: string; fill: string; track: string }> = {
  good: { label: 'Healthy', icon: CircleCheck, text: 'text-muted-foreground', fill: 'bg-neutral-400', track: 'bg-neutral-100' },
  watch: { label: 'Watch', icon: TriangleAlert, text: 'text-brand-700', fill: 'bg-brand-600', track: 'bg-brand-100' },
  risk: { label: 'At risk', icon: CircleX, text: 'text-red-700', fill: 'bg-red-600', track: 'bg-red-100' },
  none: { label: 'No data', icon: CircleDashed, text: 'text-muted-foreground', fill: 'bg-neutral-300', track: 'bg-neutral-100' },
};

/** Worse of the thresholds a value crosses: [watch from, risk from]. */
function grade(value: number | null, [watch, risk]: [number, number]): Health {
  if (value === null) return 'none';
  return value >= risk ? 'risk' : value >= watch ? 'watch' : 'good';
}

interface Check {
  name: string;
  reading: string;
  health: Health;
  /** 0–1 of the budget used; omitted for counts. */
  meter?: number;
}

/**
 * The budgets the platform imposes, and how close the agent runs to them. Every
 * threshold is here — change a line, not a component.
 */
function checks(s: Stats): Check[] {
  const { latency: l, totals: t } = s;
  const WINDOW = 30_000;
  const CAP = 180_000;
  return [
    {
      name: 'Avg time to submit',
      reading: l.close_to_submitted_ms.n ? formatLatency(l.close_to_submitted_ms.avg) : '—',
      health: grade(l.close_to_submitted_ms.avg, [10_000, 20_000]),
      meter: (l.close_to_submitted_ms.avg ?? 0) / WINDOW,
    },
    {
      name: 'Avg time per call',
      reading: l.call_ms.n ? formatDuration(l.call_ms.avg) : '—',
      health: grade(l.call_ms.avg, [120_000, 150_000]),
      meter: (l.call_ms.avg ?? 0) / CAP,
    },
    {
      name: 'Avg decider time',
      reading: l.decider_ms.n ? formatLatency(l.decider_ms.avg) : '—',
      health: grade(l.decider_ms.avg, [8_000, 15_000]),
      meter: (l.decider_ms.avg ?? 0) / WINDOW,
    },
    {
      name: 'Avg time to answer',
      reading: l.session_start_ms.n ? formatLatency(l.session_start_ms.avg) : '—',
      health: grade(l.session_start_ms.avg, [1_000, 2_000]),
      meter: (l.session_start_ms.avg ?? 0) / 2_000,
    },
    {
      name: 'Calls using fallback decision',
      reading: `${t.floor_used} of ${t.ended}`,
      health: t.ended ? grade(t.floor_used, [1, Math.max(2, Math.ceil(t.ended * 0.1))]) : 'none',
    },
    {
      name: 'Calls without a record',
      reading: `${t.without_record} of ${t.ended}`,
      health: t.ended ? grade(t.without_record, [1, 1]) : 'none',
    },
  ];
}

export function PipelineHealthCard({ stats, className }: { stats: Stats; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>Pipeline health</CardTitle>
      </CardHeader>
      <CardContent>
      <ul className="grid gap-x-8 lg:grid-cols-2">
        {checks(stats).map((c) => {
          const st = STATUS[c.health];
          return (
            <li key={c.name} className="space-y-2 border-t py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm font-medium">{c.name}</p>
                <span className={cn('flex shrink-0 items-center gap-1 text-xs font-medium', st.text)}>
                  <st.icon className="size-3.5" aria-hidden />
                  {st.label}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {c.meter !== undefined ? (
                  <div className={cn('h-1.5 flex-1 overflow-hidden rounded-full', st.track)}>
                    <div className={cn('h-full rounded-full transition-[width] duration-500', st.fill)} style={{ width: `${Math.min(1, c.meter) * 100}%` }} />
                  </div>
                ) : (
                  <span className="flex-1" />
                )}
                <span className="tabular shrink-0 text-xs text-muted-foreground">{c.reading}</span>
              </div>
            </li>
          );
        })}
      </ul>
      </CardContent>
    </Card>
  );
}
