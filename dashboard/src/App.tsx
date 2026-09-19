import { useMemo } from 'react';
import { FinishedCallsView } from '@/components/calls/finished-calls-view';
import { ClinicView } from '@/components/clinic/clinic-view';
import { AppShell, type NavItem } from '@/components/layout/app-shell';
import { LiveView } from '@/components/live/live-view';
import { OverviewView } from '@/components/overview/overview-view';
import { useAgentHealth } from '@/hooks/use-agent-health';
import { useCallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { useRoute, type View } from '@/hooks/use-route';
import { SimContext, type SimContextValue } from '@/hooks/sim-context';
import { useSimFeed } from '@/hooks/use-sim-feed';
import { callStatus } from '@/lib/agent/model';
import { liveHolds } from '@/lib/sim/model';

/**
 * One feed for the whole console: a single SSE connection to the agent, whatever
 * view is open — plus one to the shared clinic when a sim is running.
 */
export function App() {
  const feed = useCallFeed();
  const sim = useSimFeed();
  const health = useAgentHealth(feed.connected);
  const [route, navigate] = useRoute();
  const now = useNow(5_000);

  const nav: NavItem[] = useMemo(() => {
    const live = feed.calls.filter((c) => callStatus(c, now) === 'live').length;
    const items: NavItem[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'live', label: 'Live', count: live, pulse: live > 0 },
      { id: 'finished', label: 'Finished', count: feed.calls.length - live },
    ];
    // The clinic tab only when there is a clinic to show: against real Prosper there is none.
    if (sim.available || route.view === 'clinic') {
      const holds = liveHolds(sim.holds, now).length;
      items.push({ id: 'clinic', label: 'Clinic', count: holds, pulse: holds > 0 });
    }
    return items;
  }, [feed.calls, now, sim.available, sim.holds, route.view]);

  const openFinished = (callId: string | null): void => navigate({ view: 'finished', callId });
  /** From the clinic to the call that did it: live if it still is, finished otherwise. */
  const openCall = (callId: string): void => {
    const call = feed.calls.find((c) => c.id === callId);
    if (call && callStatus(call, Date.now()) === 'live') navigate({ view: 'live', callId });
    else openFinished(callId);
  };

  const simCtx: SimContextValue = useMemo(
    () => ({ sim, openClinic: (date) => navigate({ view: 'clinic', callId: date }) }),
    [sim, navigate],
  );

  return (
    <SimContext value={simCtx}>
      <AppShell
        nav={nav}
        active={route.view}
        onNavigate={(id) => navigate({ view: id as View, callId: null })}
        clinicApi={health?.clinic_api ?? null}
        simRunning={sim.available === true}
      >
        {route.view === 'overview' ? (
          <OverviewView feed={feed} />
        ) : route.view === 'clinic' ? (
          <ClinicView
            sim={sim}
            date={route.callId}
            onDate={(date) => navigate({ view: 'clinic', callId: date })}
            onOpenCall={openCall}
            agentClinicApi={health?.clinic_api ?? null}
          />
        ) : route.view === 'live' ? (
          <LiveView
            feed={feed}
            selectedId={route.callId}
            onSelect={(callId) => navigate({ view: 'live', callId })}
            onOpenFinished={openFinished}
          />
        ) : (
          <FinishedCallsView feed={feed} selectedId={route.callId} onSelect={openFinished} />
        )}
      </AppShell>
    </SimContext>
  );
}
