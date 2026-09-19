import { ArrowRight, PhoneIncoming, PhoneOff, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { OutcomeBadge } from '@/components/calls/outcome-badge';
import { RecordCard } from '@/components/calls/record-card';
import { TimelineEvent, Transcript } from '@/components/calls/transcript';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type Call, callStatus } from '@/lib/agent/model';
import { formatClock, formatDuration, formatPhone, shortId } from '@/lib/format';
import { elapsedMs } from '@/lib/live';

interface LiveCallPanelProps {
  call: Call;
  now: number;
  onClose: () => void;
  onOpenFinished: () => void;
}

/** How close to the bottom still counts as "following along". */
const FOLLOW_SLACK_PX = 96;

/**
 * One call, followed as it happens. New lines scroll into view only while you are
 * already at the bottom — scroll up to reread something and it stays put.
 */
export function LiveCallPanel({ call, now, onClose, onOpenFinished }: LiveCallPanelProps) {
  const status = callStatus(call, now);
  const live = status === 'live';
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };

  // A different call starts at its latest line.
  useLayoutEffect(() => {
    following.current = true;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [call.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [call.turns.length, call.submissions.length, call.endedAt]);

  const phone = formatPhone(call.fromNumber);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b bg-card px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate font-heading text-base font-medium">{phone ?? 'Withheld number'}</h2>
            {live ? (
              <Badge variant="brand">
                <BadgeDot />
                Live
              </Badge>
            ) : (
              <OutcomeBadge call={call} status={status} />
            )}
          </div>
          <p className="tabular text-sm text-muted-foreground">
            {formatDuration(elapsedMs(call, now))} · {call.turnCount} {call.turnCount === 1 ? 'turn' : 'turns'} ·{' '}
            <span className="font-mono text-xs">{shortId(call.id)}</span>
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="-mr-1 text-muted-foreground">
          <X />
        </Button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-muted/40">
        <div className="space-y-5 px-4 py-5">
          <TimelineEvent>
            <PhoneIncoming className="size-3.5" />
            Call connected · {formatClock(call.startedAt, true)}
          </TimelineEvent>

          {call.turns.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Waiting for the first words…</p>
          ) : (
            <Transcript turns={call.turns} />
          )}

          {live ? (
            <div className="flex items-center justify-center gap-1.5 py-1" aria-label="Call in progress">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="size-1.5 animate-pulse rounded-full bg-brand-500/70"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : (
            <>
              <TimelineEvent>
                <PhoneOff className="size-3.5" />
                Call ended · {formatDuration(call.durationMs)}
              </TimelineEvent>
              <RecordCard call={call} />
              <Button variant="outline" size="sm" onClick={onOpenFinished} className="mx-auto flex">
                Open in Finished
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
