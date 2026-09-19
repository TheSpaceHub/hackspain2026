import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortId } from '@/lib/format';
import { callHue, formatSlot } from '@/lib/sim/model';
import type { Hold } from '@/lib/sim/wire';
import { cn } from '@/lib/utils';

interface HoldsPanelProps {
  holds: Hold[];
  now: number;
  onOpenCall: (callId: string) => void;
  onRelease: (hold: Hold) => void;
}

/** Every slot a call is holding right now, with how long it has left. */
export function HoldsPanel({ holds, now, onOpenCall, onRelease }: HoldsPanelProps) {
  if (holds.length === 0) {
    return <p className="px-1 py-3 text-xs text-muted-foreground">No slot is on hold. A call holds one while it confirms with the caller.</p>;
  }
  const sorted = [...holds].sort((a, b) => a.expires_at - b.expires_at);
  return (
    <ul className="flex flex-col divide-y">
      {sorted.map((h) => {
        const leftMs = h.expires_at - now;
        const total = h.expires_at - h.created_at;
        const frac = total > 0 ? Math.max(0, Math.min(1, leftMs / total)) : 0;
        const hue = callHue(h.call_id);
        return (
          <li key={h.hold_id} className="flex items-center gap-3 py-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${hue} 70% 50%)` }} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium">
                  {h.provider_id} · {formatSlot(h.start_time)}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {h.appointment_type_id} · {h.location_id}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenCall(h.call_id)}
                  className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title={h.call_id}
                >
                  call {shortId(h.call_id)}
                </button>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn('block h-full rounded-full transition-[width]', leftMs < 20_000 ? 'bg-destructive' : 'bg-foreground/50')}
                    style={{ width: `${frac * 100}%` }}
                  />
                </span>
                <span className={cn('tabular w-8 text-right text-[11px]', leftMs < 20_000 ? 'text-destructive' : 'text-muted-foreground')}>
                  {Math.max(0, Math.ceil(leftMs / 1000))}s
                </span>
              </div>
            </div>
            <Button variant="ghost" size="icon-xs" title={`Release ${h.hold_id}`} onClick={() => onRelease(h)}>
              <X />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
