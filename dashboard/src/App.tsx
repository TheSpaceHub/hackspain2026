import { useMemo } from 'react';
import { FinishedCallsView } from '@/components/calls/finished-calls-view';
import { AppShell, type NavItem } from '@/components/layout/app-shell';
import { LiveView } from '@/components/live/live-view';
import { OverviewView } from '@/components/overview/overview-view';
import { TestCallView } from '@/components/test/test-call-view';
import { useAgentHealth } from '@/hooks/use-agent-health';
import { useCallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { useRoute, type View } from '@/hooks/use-route';
import { useTestCall } from '@/hooks/use-test-call';
import { callStatus } from '@/lib/agent/model';

/** One feed for the whole console: a single SSE connection, whatever view is open. */
export function App() {
  const feed = useCallFeed();
  const health = useAgentHealth(feed.connected);
  const [route, navigate] = useRoute();
  const now = useNow(5_000);
  const testCall = useTestCall();
  const onTestCall = testCall.snapshot.phase === 'live';

  const nav: NavItem[] = useMemo(() => {
    const live = feed.calls.filter((c) => callStatus(c, now) === 'live').length;
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'live', label: 'Live', count: live, pulse: live > 0 },
      { id: 'finished', label: 'Finished', count: feed.calls.length - live },
      { id: 'test', label: 'Test call', count: onTestCall ? 1 : undefined, pulse: onTestCall },
    ];
  }, [feed.calls, now, onTestCall]);

  const openFinished = (callId: string | null): void => navigate({ view: 'finished', callId });

  return (
    <AppShell
      nav={nav}
      active={route.view}
      onNavigate={(id) => navigate({ view: id as View, callId: null })}
      clinicApi={health?.clinic_api ?? null}
    >
      {route.view === 'overview' ? (
        <OverviewView feed={feed} />
      ) : route.view === 'live' ? (
        <LiveView
          feed={feed}
          selectedId={route.callId}
          onSelect={(callId) => navigate({ view: 'live', callId })}
          onOpenFinished={openFinished}
        />
      ) : route.view === 'test' ? (
        <TestCallView call={testCall} feed={feed} onOpenCall={(view, callId) => navigate({ view, callId })} />
      ) : (
        <FinishedCallsView feed={feed} selectedId={route.callId} onSelect={openFinished} />
      )}
    </AppShell>
  );
}
