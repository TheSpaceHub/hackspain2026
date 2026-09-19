import { Hospital } from 'lucide-react';
import { useMemo } from 'react';
import { useSim } from '@/hooks/sim-context';
import { formatClock } from '@/lib/format';
import { describe, formatSlot, liveHolds, type Tone } from '@/lib/sim/model';
import { cn } from '@/lib/utils';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-sky-700 dark:text-sky-400',
  success: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
};

/**
 * What one call did to the shared clinic: the slots it is holding right now and
 * the holds, bookings and refusals the clinic logged for it. Nothing when no sim
 * is running or the clinic has not heard of the call.
 */
export function ClinicTrace({ callId, now }: { callId: string; now: number }) {
  const ctx = useSim();
  const holds = useMemo(() => (ctx ? liveHolds(ctx.sim.holds, now).filter((h) => h.call_id === callId) : []), [ctx, callId, now]);
  const lines = useMemo(
    () =>
      ctx
        ? ctx.sim.events
            .filter((e) => e.call_id === callId && e.type !== 'call_opened' && e.type !== 'call_closed')
            .map(describe)
        : [],
    [ctx, callId],
  );
  if (!ctx || ctx.sim.available !== true || (holds.length === 0 && lines.length === 0)) return null;

  return (
    <section className="rounded-lg border bg-card px-3 py-2.5">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Hospital className="size-3.5" aria-hidden />
        In the clinic
      </h3>
      {holds.length > 0 && (
        <ul className="mb-1.5 space-y-1">
          {holds.map((h) => (
            <li key={h.hold_id} className="flex items-center gap-2 text-sm">
              <span className="rounded bg-sky-500/10 px-1.5 text-[11px] font-medium text-sky-700 dark:text-sky-400">holding</span>
              <button
                type="button"
                className="truncate underline-offset-2 hover:underline"
                onClick={() => ctx.openClinic(h.date)}
                title="Open in the diary"
              >
                {h.provider_id} · {formatSlot(h.start_time)}
              </button>
              <span className="tabular ml-auto text-xs text-muted-foreground">{Math.max(0, Math.round((h.expires_at - now) / 1000))}s</span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <ol className="space-y-0.5">
          {lines.map((l) => (
            <li key={l.id} className="flex items-baseline gap-2 text-xs leading-5">
              <span className="tabular shrink-0 text-muted-foreground">{formatClock(new Date(l.at).toISOString(), true)}</span>
              <span className={cn('shrink-0 font-medium', TONE_TEXT[l.tone])}>{l.label}</span>
              <span className="min-w-0 truncate text-foreground/80" title={l.text}>
                {l.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
