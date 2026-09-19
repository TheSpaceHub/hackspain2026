import { TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Range, Stats } from '@/lib/agent/stats';
import { cn } from '@/lib/utils';

/**
 * Fixed order, so a bar never moves when the numbers change and a missing outcome
 * shows as an empty track rather than vanishing.
 */
const ROWS: { key: string; label: string }[] = [
  { key: 'book', label: 'Booked' },
  { key: 'register', label: 'Registered' },
  { key: 'reschedule', label: 'Rescheduled' },
  { key: 'cancel', label: 'Cancelled' },
  { key: 'no_action', label: 'No action' },
  { key: 'escalate', label: 'Escalated' },
  { key: 'none', label: 'No record' },
];

/**
 * What finished calls ended in. One series, so one colour — except "No record",
 * which is a failure whatever else happened and wears the status red with an icon.
 */
export function OutcomesCard({ stats, range }: { stats: Stats; range: Range }) {
  const total = stats.totals.ended;
  const max = Math.max(1, ...ROWS.map((r) => stats.outcomes[r.key] ?? 0));

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Outcomes</CardTitle>
        <CardDescription>{`What ${total} finished ${total === 1 ? 'call' : 'calls'} recorded, ${range.phrase}`}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        <ul className="space-y-3.5">
          {ROWS.map((row) => {
            const n = stats.outcomes[row.key] ?? 0;
            const failure = row.key === 'none';
            const pct = total ? Math.round((n / total) * 100) : 0;
            return (
              <li key={row.key} className="group space-y-1.5" title={`${row.label}: ${n} (${pct}%)`}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className={cn('flex items-center gap-1.5', n === 0 && 'text-muted-foreground')}>
                    {failure && n > 0 && <TriangleAlert className="size-3.5 text-red-600" aria-hidden />}
                    {row.label}
                  </span>
                  <span className="tabular text-muted-foreground">
                    <span className={cn('font-medium', n > 0 ? 'text-foreground' : '')}>{n}</span>
                    <span className="ml-1.5 inline-block w-9 text-right text-xs">{pct}%</span>
                  </span>
                </div>
                {/* Same-ramp track under the fill; the fill is a 4px-rounded thin bar. */}
                <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500 group-hover:brightness-110',
                      failure ? 'bg-red-600' : 'bg-brand-600',
                    )}
                    style={{ width: `${(n / max) * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
