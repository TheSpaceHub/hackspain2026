import { useMemo, useState } from 'react';
import { FinishedCallsView } from '@/components/calls/finished-calls-view';
import { ClinicView } from '@/components/clinic/clinic-view';
import { ConnectAgent } from '@/components/layout/agent-origin';
import { AppShell, type NavItem } from '@/components/layout/app-shell';
import { LiveView } from '@/components/live/live-view';
import { OverviewView } from '@/components/overview/overview-view';
import { TestingView } from '@/components/testing/testing-view';
import { useAgentHealth } from '@/hooks/use-agent-health';
import { useCallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { useRoute, type View } from '@/hooks/use-route';
import { SimContext, type SimContextValue } from '@/hooks/sim-context';
import { useSimFeed } from '@/hooks/use-sim-feed';
import { needsAgentOrigin, storedMode, storeMode, type AgentMode } from '@/lib/agent/origin';
import { callStatus } from '@/lib/agent/model';
import { consoleMode } from '@/lib/mode';
import { liveHolds } from '@/lib/sim/model';

/**
 * One feed for the whole console: a single SSE connection to the agent, whatever
 * view is open — plus one to the shared clinic when a sim is running.
 */
export function App() {
  const [agentMode, setAgentModeState] = useState<AgentMode>(storedMode);
  const feed = useCallFeed(agentMode);
  const sim = useSimFeed();
  const { health } = useAgentHealth(feed.connected, agentMode);
  const [route, navigate] = useRoute();
  const now = useNow(5_000);
  const clinicApi = health?.clinic_api ?? null;
  const actualMode = consoleMode(clinicApi);
  const nav: NavItem[] = useMemo(() => {
    const live = feed.calls.filter((c) => callStatus(c, now) === 'live').length;
    const items: NavItem[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'live', label: 'Live', count: live, pulse: live > 0 },
      { id: 'finished', label: 'Finished', count: feed.calls.length - live },
    ];
    // The clinic tab belongs to simulation mode only: in live mode the clinic is Prosper's, not ours.
    if (actualMode === 'simulation' || route.view === 'clinic') {
      const holds = liveHolds(sim.holds, now).length;
      items.push({ id: 'clinic', label: 'Clinic', count: holds, pulse: holds > 0 });
    }
    items.push({ id: 'testing', label: 'Testing' });
    return items;
  }, [feed.calls, now, actualMode, sim.holds, route.view]);

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
        clinicApi={clinicApi}
        mode={agentMode}
        consoleMode={actualMode}
        onMode={(m) => {
          if (m === 'live' && route.view === 'clinic') navigate({ view: 'overview', callId: null });
          storeMode(m);
          setAgentModeState(m);
        }}
      >
        {needsAgentOrigin(agentMode) ? (
          <ConnectAgent mode={agentMode} />
        ) : route.view === 'overview' ? (
          <OverviewView feed={feed} mode={agentMode} />
        ) : route.view === 'clinic' ? (
          <ClinicView
            mode={agentMode}
            sim={sim}
            liveCalls={feed.calls.filter((c) => callStatus(c, now) === 'live')}
            date={route.callId}
            onDate={(date) => navigate({ view: 'clinic', callId: date })}
            onOpenCall={openCall}
            agentClinicApi={clinicApi}
          />
        ) : route.view === 'live' ? (
          <LiveView
            mode={agentMode}
            feed={feed}
            selectedId={route.callId}
            onSelect={(callId) => navigate({ view: 'live', callId })}
            onOpenFinished={openFinished}
          />
        ) : route.view === 'testing' ? (
          <TestingView />
        ) : (
          <FinishedCallsView mode={agentMode} feed={feed} selectedId={route.callId} onSelect={openFinished} />
        )}
      </AppShell>
    </SimContext>
  );
}
