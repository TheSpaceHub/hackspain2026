import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  /** Why it matters, in the words of the rules. */
  why: string;
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
      name: 'Submission window',
      why: 'POST within 30 s of hang-up, or 410',
      reading: l.close_to_submitted_ms.n ? `p95 ${formatLatency(l.close_to_submitted_ms.p95)} · max ${formatLatency(l.close_to_submitted_ms.max)}` : '—',
      health: grade(l.close_to_submitted_ms.max, [10_000, 20_000]),
      meter: (l.close_to_submitted_ms.max ?? 0) / WINDOW,
    },
    {
      name: 'Call length',
      why: 'Cut at 3:00 — a call that runs out fails',
      reading: l.call_ms.n ? `p50 ${formatDuration(l.call_ms.p50)} · p95 ${formatDuration(l.call_ms.p95)}` : '—',
      health: grade(l.call_ms.p95, [120_000, 150_000]),
      meter: (l.call_ms.p95 ?? 0) / CAP,
    },
    {
      name: 'Decider',
      why: 'Runs inside the submission window',
      reading: l.decider_ms.n ? `p50 ${formatLatency(l.decider_ms.p50)} · p95 ${formatLatency(l.decider_ms.p95)}` : '—',
      health: grade(l.decider_ms.p95, [8_000, 15_000]),
      meter: (l.decider_ms.p95 ?? 0) / WINDOW,
    },
    {
      name: 'Agent ready',
      why: 'Session up before the caller speaks',
      reading: l.session_start_ms.n ? `p95 ${formatLatency(l.session_start_ms.p95)}` : '—',
      health: grade(l.session_start_ms.p95, [1_000, 2_000]),
      meter: (l.session_start_ms.p95 ?? 0) / 2_000,
    },
    {
      name: 'Decider fell back',
      why: 'The floor answered instead of the model',
      reading: `${t.floor_used} of ${t.ended}`,
      health: t.ended ? grade(t.floor_used, [1, Math.max(2, Math.ceil(t.ended * 0.1))]) : 'none',
    },
    {
      name: 'Calls without a record',
      why: 'Nothing accepted is always a failed case',
      reading: `${t.without_record} of ${t.ended}`,
      health: t.ended ? grade(t.without_record, [1, 1]) : 'none',
    },
  ];
}

export function PipelineHealthCard({ stats }: { stats: Stats }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Pipeline health</CardTitle>
        <CardDescription>How close the agent runs to the platform’s limits</CardDescription>
      </CardHeader>
      <CardContent>
      <ul className="-my-3 divide-y">
        {checks(stats).map((c) => {
          const st = STATUS[c.health];
          return (
            <li key={c.name} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{c.why}</p>
                </div>
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
