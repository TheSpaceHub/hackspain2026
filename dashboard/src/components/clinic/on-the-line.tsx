import { PhoneIncoming } from 'lucide-react';
import { ListenButton } from '@/components/live/listen-button';
import type { Call } from '@/lib/agent/model';
import { formatDuration, formatPhone, shortId } from '@/lib/format';
import { elapsedMs } from '@/lib/live';
import { callHue } from '@/lib/sim/model';
import type { Hold } from '@/lib/sim/wire';

interface OnTheLineProps {
  /** Calls the agent has open right now, whichever clinic they are on. */
  calls: Call[];
  holds: Hold[];
  now: number;
  onOpenCall: (callId: string) => void;
}

/** Who is talking to the clinic this second, with the audio a click away. */
export function OnTheLine({ calls, holds, now, onOpenCall }: OnTheLineProps) {
  if (calls.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">Nobody on the line.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {calls.map((c) => {
        const hue = callHue(c.id);
        const held = holds.filter((h) => h.call_id === c.id).length;
        return (
          <li key={c.id} className="flex items-center gap-3 rounded-md border px-2.5 py-1.5 text-sm">
            <span className="size-2 shrink-0 rounded-full" style={{ background: `hsl(${hue} 70% 50%)` }} />
            <button
              type="button"
              onClick={() => onOpenCall(c.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
              title={c.id}
            >
              <PhoneIncoming className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.fromNumber ? formatPhone(c.fromNumber) : 'Unknown number'}</span>
              <span className="font-mono text-xs text-muted-foreground">{shortId(c.id)}</span>
            </button>
            <span className="tabular text-xs text-muted-foreground">
              {formatDuration(elapsedMs(c, now))}
              {held > 0 && ` · ${held} hold${held === 1 ? '' : 's'}`}
            </span>
            <ListenButton id={c.id} />
          </li>
        );
      })}
    </ul>
  );
}
