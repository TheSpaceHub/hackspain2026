import { PhoneIncoming, PhoneOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { type Call, callStatus } from '@/lib/agent/model';
import { formatClock, formatDay, formatDuration, formatPhone, shortId } from '@/lib/format';
import { OutcomeBadge } from './outcome-badge';
import { RecordCard } from './record-card';
import { TimelineEvent, Transcript } from './transcript';

/** Why the line went down, in words — the store keeps the trigger's name. */
const ENDED_BY: Record<string, string> = {
  stop: 'caller hung up',
  socket_close: 'line dropped',
  wall_clock: '3-minute limit',
};

interface CallDetailProps {
  call: Call;
  loading: boolean;
  now: number;
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-5">
      {[62, 44, 70, 38].map((w, i) => (
        <div key={i} className={i % 2 ? 'flex flex-row-reverse items-end gap-2.5' : 'flex items-end gap-2.5'}>
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-10 rounded-2xl" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

export function CallDetail({ call, loading, now }: CallDetailProps) {
  const status = callStatus(call, now);
  const phone = formatPhone(call.fromNumber);
  const endedBy = call.endedBy ? (ENDED_BY[call.endedBy] ?? call.endedBy.replace(/_/g, ' ')) : null;
  // `ended_at` is stamped after the decider and the POST; the line went down call_ms after start.
  const hungUpAt =
    call.durationMs !== null ? new Date(Date.parse(call.startedAt) + call.durationMs).toISOString() : call.endedAt;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b bg-card px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate font-heading text-base font-medium">{phone ?? 'Withheld number'}</h2>
            <OutcomeBadge call={call} status={status} />
          </div>
          <p className="tabular text-sm text-muted-foreground">
            {formatDay(call.startedAt, now)} · {formatClock(call.startedAt)} · {formatDuration(call.durationMs)} ·{' '}
            {call.turnCount} {call.turnCount === 1 ? 'turn' : 'turns'}
          </p>
        </div>
        <code className="shrink-0 rounded-md border bg-background px-2 py-1 font-mono text-xs text-muted-foreground" title={call.id}>
          {shortId(call.id)}
        </code>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
          <TimelineEvent>
            <PhoneIncoming className="size-3.5" />
            Call connected · {formatClock(call.startedAt, true)}
          </TimelineEvent>

          {loading ? <TranscriptSkeleton /> : <Transcript turns={call.turns} />}

          {hungUpAt && (
            <TimelineEvent>
              <PhoneOff className="size-3.5" />
              Call ended · {formatClock(hungUpAt, true)}
              {endedBy && ` · ${endedBy}`}
            </TimelineEvent>
          )}

          {!loading && <RecordCard call={call} />}
        </div>
      </div>
    </div>
  );
}
