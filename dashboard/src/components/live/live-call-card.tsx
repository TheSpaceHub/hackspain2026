import { OutcomeBadge } from '@/components/calls/outcome-badge';
import { type Call, callStatus } from '@/lib/agent/model';
import { formatDuration, formatPhone } from '@/lib/format';
import { capProgress, elapsedMs, type WallState } from '@/lib/live';
import { cn } from '@/lib/utils';

interface LiveCallCardProps {
  call: Call;
  state: WallState;
  selected: boolean;
  onSelect: () => void;
  now: number;
}

const TAIL = 3;

/** One call on the wall: who, how long, how close to the cut, and what was last said. */
export function LiveCallCard({ call, state, selected, onSelect, now }: LiveCallCardProps) {
  const live = state === 'live';
  const progress = capProgress(call, now);
  const tail = call.turns.slice(-TAIL);
  const phone = formatPhone(call.fromNumber);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex h-full flex-col gap-3 rounded-xl bg-card p-4 text-left shadow-xs ring-1 ring-foreground/10 transition-[box-shadow,opacity] duration-300',
        'animate-in fade-in-0 slide-in-from-bottom-1',
        selected ? 'ring-2 ring-brand-600/70' : 'hover:shadow-md',
        !live && 'opacity-75',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex size-2 shrink-0">
            {live && <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/60" />}
            <span className={cn('relative size-2 rounded-full', live ? 'bg-brand-500' : 'bg-neutral-300')} />
          </span>
          <span className={cn('truncate text-sm', phone ? 'font-medium' : 'text-muted-foreground italic')}>
            {phone ?? 'Withheld number'}
          </span>
        </div>
        <span className={cn('tabular shrink-0 text-sm font-medium', live ? 'text-foreground' : 'text-muted-foreground')}>
          {formatDuration(elapsedMs(call, now))}
        </span>
      </div>

      {/* The three-minute cut: calm until the last half-minute. */}
      <div className="h-1 overflow-hidden rounded-full bg-muted" title="Time to Prosper's three-minute limit">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-1000 ease-linear',
            !live ? 'bg-neutral-300' : progress > 5 / 6 ? 'bg-red-500' : 'bg-brand-600',
          )}
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="min-h-[4.5rem] flex-1 space-y-1.5">
        {tail.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Connecting…</p>
        ) : (
          tail.map((t) => (
            <p key={t.seq} className="line-clamp-2 text-sm leading-snug">
              <span className={cn('mr-1.5 text-xs font-medium', t.role === 'assistant' ? 'text-brand-700' : 'text-muted-foreground')}>
                {t.role === 'assistant' ? 'Agent' : 'Caller'}
              </span>
              <span className="text-foreground/90">{t.text}</span>
            </p>
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="tabular text-xs text-muted-foreground">
          {call.turnCount} {call.turnCount === 1 ? 'turn' : 'turns'}
        </span>
        {live ? (
          <span className="text-xs font-medium text-brand-700">In progress</span>
        ) : (
          <OutcomeBadge call={call} status={callStatus(call, now)} />
        )}
      </div>
    </button>
  );
}
