import { useMemo } from 'react';
import { formatClock, shortId } from '@/lib/format';
import { describe, type Tone } from '@/lib/sim/model';
import type { SimEvent } from '@/lib/sim/wire';
import { cn } from '@/lib/utils';

interface EventTickerProps {
  events: SimEvent[];
  onOpenCall: (callId: string) => void;
  /** Show at most this many, newest first. */
  limit?: number;
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'bg-destructive/10 text-destructive',
};

/** The clinic's log as it happens: one line per hold, booking, refusal, call. */
export function EventTicker({ events, onOpenCall, limit = 80 }: EventTickerProps) {
  const lines = useMemo(() => events.slice(-limit).reverse().map(describe), [events, limit]);
  if (lines.length === 0) return <p className="px-1 py-3 text-xs text-muted-foreground">Nothing has happened yet.</p>;
  return (
    <ol className="flex flex-col divide-y">
      {lines.map((l) => (
        <li key={l.id} className="flex items-start gap-2 py-1.5 text-xs leading-5">
          <span className="tabular shrink-0 text-muted-foreground">{formatClock(new Date(l.at).toISOString(), true)}</span>
          <span className={cn('shrink-0 rounded px-1.5 text-[11px] font-medium', TONE_CLASS[l.tone])}>{l.label}</span>
          <span className="min-w-0 flex-1 truncate" title={l.text}>
            {l.text}
          </span>
          {l.callId && (
            <button
              type="button"
              onClick={() => onOpenCall(l.callId!)}
              className="shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              title={l.callId}
            >
              {shortId(l.callId)}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
