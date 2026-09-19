import { CalendarDays, ChevronLeft, ChevronRight, RotateCcw, Unplug } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/calls/empty-state';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDiary } from '@/hooks/use-diary';
import { useNow } from '@/hooks/use-now';
import type { SimFeed } from '@/hooks/use-sim-feed';
import { dayKey, formatClock, formatDay } from '@/lib/format';
import { isSimUrl, releaseHold } from '@/lib/sim/client';
import { liveHolds } from '@/lib/sim/model';
import type { Hold } from '@/lib/sim/wire';
import { DiaryGrid } from './diary-grid';
import { EventTicker } from './event-ticker';
import { HoldsPanel } from './holds-panel';

interface ClinicViewProps {
  sim: SimFeed;
  /** The day open, YYYY-MM-DD; null for today. */
  date: string | null;
  onDate: (date: string) => void;
  onOpenCall: (callId: string) => void;
  /** What the agent's /health says it submits to — a warning when it is not this clinic. */
  agentClinicApi: string | null;
}

const DAY_MS = 86_400_000;

function shiftDay(date: string, days: number): string {
  return dayKey(new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString());
}

/**
 * The shared clinic itself, not the calls: whose diary has what, which slots are on
 * hold by which call, what just happened, and a way back to the snapshot.
 */
export function ClinicView({ sim, date: routeDate, onDate, onOpenCall, agentClinicApi }: ClinicViewProps) {
  const now = useNow(1_000);
  const today = dayKey(new Date(now).toISOString());
  const date = routeDate ?? today;
  const { diary, loading, error } = useDiary(date, sim.diaryVersion, sim.available === true);
  const holds = useMemo(() => liveHolds(sim.holds, now), [sim.holds, now]);
  const dayHolds = useMemo(() => holds.filter((h) => h.date === date), [holds, date]);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = async (resnapshot: boolean): Promise<void> => {
    const what = resnapshot ? 'Re-copy the live clinic and reset? Every local booking, hold and call is lost.' : 'Reset to the snapshot? Every local booking, hold and call is lost.';
    if (!window.confirm(what)) return;
    setBusy(true);
    try {
      const r = await sim.reset(resnapshot);
      setNotice({
        text: resnapshot ? `Re-snapshotted from ${r.live ?? 'the live API'} and reset` : 'Back to the snapshot',
        tone: 'ok',
      });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Reset failed', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const release = async (hold: Hold): Promise<void> => {
    try {
      await releaseHold(hold);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Release failed', tone: 'error' });
    }
  };

  if (sim.available === false) {
    return (
      <div className="h-full p-4">
        <EmptyState icon={Unplug} title="No shared clinic running">
          Simulation mode needs the sim on :8788 and the agent pointed at it: <code className="font-mono text-xs">pnpm sim</code> then{' '}
          <code className="font-mono text-xs">pnpm start:sim</code>. Live mode is the plain <code className="font-mono text-xs">pnpm start</code>.
        </EmptyState>
      </div>
    );
  }

  const agentElsewhere = agentClinicApi !== null && !isSimUrl(agentClinicApi);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => onDate(shiftDay(date, -1))} title="Previous day">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDate(today)} disabled={date === today}>
            Today
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => onDate(shiftDay(date, 1))} title="Next day">
            <ChevronRight />
          </Button>
          <label className="ml-2 flex items-center gap-1.5 text-sm">
            <CalendarDays className="size-4 text-muted-foreground" />
            <span className="font-medium">{formatDay(`${date}T12:00:00+02:00`, now)}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && onDate(e.target.value)}
              className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
            />
          </label>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={sim.connected ? 'brand' : 'secondary'}>
            <BadgeDot />
            {sim.connected ? 'streaming' : 'reconnecting'}
          </Badge>
          {sim.state && (
            <>
              <span className="tabular">
                <b className="font-semibold text-foreground">{sim.state.appointments.local}</b> booked here ·{' '}
                <b className="font-semibold text-foreground">{sim.state.appointments.prosper}</b> from the clinic ·{' '}
                <b className="font-semibold text-foreground">{sim.state.appointments.cancelled}</b> cancelled
              </span>
              <span className="tabular">
                <b className="font-semibold text-foreground">{sim.state.patients.local}</b> new patients
              </span>
              <span className="tabular">
                <b className="font-semibold text-foreground">{sim.state.calls.open}</b> calls open
              </span>
              <span title={`Snapshot of ${sim.state.snapshot.source}`}>
                snapshot {formatDay(sim.state.snapshot.taken_at, now).toLowerCase()} {formatClock(sim.state.snapshot.taken_at)}
              </span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {notice && (
            <span className={notice.tone === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{notice.text}</span>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void reset(false)} title="Forget every local booking, hold and call">
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !sim.state?.live}
            onClick={() => void reset(true)}
            title={sim.state?.live ? `Copy ${sim.state.live} again, then reset` : 'No live API configured'}
          >
            Re-snapshot
          </Button>
        </div>
      </div>

      {agentElsewhere && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          The console is in live mode: the agent submits to <span className="font-mono">{agentClinicApi}</span>, not to this clinic, so calls
          will not show up here. For simulation mode restart the agent with <code className="font-mono">pnpm start:sim</code>.
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1fr_400px]">
        <Card size="sm" className="min-h-0 gap-3">
          <CardHeader>
            <CardTitle>Diary</CardTitle>
            <CardDescription>
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                <Legend className="bg-muted/70" label="free" />
                <Legend className="bg-foreground/15" label="clinic's own" />
                <Legend className="bg-brand-500/85" label="booked by a call" />
                <Legend className="ring-[1.5px] ring-sky-600 ring-inset bg-sky-500/20" label="on hold (one colour per call)" />
                {diary?.closed && <Badge variant="secondary">closed</Badge>}
                {error && <span className="text-destructive">diary failed to load</span>}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 overflow-y-auto">
            {diary ? (
              <div className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                <DiaryGrid diary={diary} holds={dayHolds} now={now} onOpenCall={onOpenCall} />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col gap-4">
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle>
                Holds <span className="tabular font-normal text-muted-foreground">{holds.length}</span>
              </CardTitle>
              <CardDescription>Slots a call has reserved while it confirms — invisible to every other call until they lapse.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-64 overflow-y-auto">
              <HoldsPanel holds={holds} now={now} onOpenCall={onOpenCall} onRelease={(h) => void release(h)} />
            </CardContent>
          </Card>
          <Card size="sm" className="min-h-0 flex-1 gap-2">
            <CardHeader>
              <CardTitle>Events</CardTitle>
              <CardDescription>What the clinic just did, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              <EventTicker events={sim.events} onOpenCall={onOpenCall} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-3 w-4 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
