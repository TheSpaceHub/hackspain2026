import { ArrowRight, Loader2, Phone, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CallFeed } from '@/hooks/use-call-feed';
import { useNow } from '@/hooks/use-now';
import { callStatus } from '@/lib/agent/model';
import { formatDuration } from '@/lib/format';
import type { TestCall } from '@/lib/phone/test-call';
import { cn } from '@/lib/utils';

/** The URL Prosper dials, and the agent behind this console (through Vite's proxy). */
const PRESETS = [
  { label: 'Prosper endpoint', url: 'wss://pmc-blowing-rap-detroit.trycloudflare.com/ws' },
  { label: 'Local agent', url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` },
];

/** Per-browser settings: which agent to ring, and as whom. */
function useStored(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private window: the setting just does not persist
    }
  }, [key, value]);
  return [value, setValue];
}

interface TestCallViewProps {
  call: TestCall;
  feed: CallFeed;
  onOpenCall: (view: 'live' | 'finished', callId: string) => void;
}

/** Ring the agent from the browser and talk to it, like a caller would. */
export function TestCallView({ call, feed, onOpenCall }: TestCallViewProps) {
  const s = call.snapshot;
  const now = useNow(1_000);
  const [endpoint, setEndpoint] = useStored('test-call.endpoint', PRESETS[0]!.url);
  const [fromNumber, setFromNumber] = useStored('test-call.from', '');

  const busy = s.phase === 'connecting' || s.phase === 'live';
  // The call shows up in this console only when it went to the agent this console reads.
  const tracked = s.callId ? feed.calls.find((c) => c.id === s.callId) : undefined;

  const onPress = (): void => {
    if (busy) call.hangUp();
    else void call.start({ endpoint, fromNumber });
  };

  const status =
    s.phase === 'connecting'
      ? 'Connecting…'
      : s.phase === 'live'
        ? `${formatDuration(s.startedAt ? now - s.startedAt : 0)} · ${s.agentSpeaking ? 'Agent speaking' : 'Listening'}`
        : s.phase === 'ended'
          ? (s.error ?? `Call ended · ${formatDuration(s.startedAt && s.endedAt ? s.endedAt - s.startedAt : 0)}`)
          : 'Talk to the agent through your microphone';

  return (
    <div className="flex h-full flex-col items-center justify-between gap-8 p-4">
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <div className="relative grid size-72 place-items-center">
          {/* The caller's voice: a soft halo that swells with the microphone level. */}
          <span
            className="absolute size-44 rounded-full bg-brand-500/15 transition-transform duration-100"
            style={{ transform: `scale(${s.phase === 'live' ? 1 + s.micLevel * 0.55 : 1})` }}
          />
          {/* The agent's voice: rings pulsing out while its audio plays. */}
          {s.phase === 'live' && s.agentSpeaking && (
            <>
              <span className="absolute size-44 animate-ping rounded-full border-2 border-brand-500/40 [animation-duration:1.6s]" />
              <span className="absolute size-52 animate-ping rounded-full border border-brand-500/25 [animation-delay:400ms] [animation-duration:1.6s]" />
            </>
          )}
          <button
            type="button"
            onClick={onPress}
            aria-label={busy ? 'End call' : 'Call the agent'}
            className={cn(
              'relative flex size-44 flex-col items-center justify-center gap-2 rounded-full text-white transition-all duration-300',
              'focus-visible:ring-4 focus-visible:ring-brand-500/40 focus-visible:outline-none active:scale-95',
              busy
                ? 'bg-neutral-900 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.55)] hover:bg-neutral-800'
                : 'bg-gradient-to-b from-brand-400 to-brand-600 shadow-[0_24px_60px_-18px_var(--color-brand-600)] hover:scale-105 hover:shadow-[0_30px_70px_-18px_var(--color-brand-600)]',
            )}
          >
            {s.phase === 'connecting' ? (
              <Loader2 className="size-10 animate-spin" />
            ) : busy ? (
              <PhoneOff className="size-10" strokeWidth={1.75} />
            ) : (
              <Phone className="size-10" strokeWidth={1.75} />
            )}
            <span className="text-lg font-semibold tracking-tight">
              {s.phase === 'connecting' ? 'Cancel' : busy ? 'End' : 'Call'}
            </span>
          </button>
        </div>

        <div className="flex min-h-16 flex-col items-center gap-3">
          <p className={cn('tabular text-sm', s.error ? 'text-red-700' : 'text-muted-foreground')}>
            {status}
          </p>
          {tracked && s.callId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenCall(callStatus(tracked, now) === 'live' ? 'live' : 'finished', s.callId!)}
            >
              {callStatus(tracked, now) === 'live' ? 'Follow it in Live' : 'Open in Finished'}
              <ArrowRight data-icon="inline-end" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid w-full max-w-xl gap-3 text-sm">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between text-xs text-muted-foreground">
            Endpoint
            <span className="flex gap-1">
              {PRESETS.map((p) => (
                <Button
                  key={p.url}
                  variant={endpoint === p.url ? 'secondary' : 'ghost'}
                  size="xs"
                  disabled={busy}
                  onClick={() => setEndpoint(p.url)}
                >
                  {p.label}
                </Button>
              ))}
            </span>
          </span>
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} disabled={busy} className="font-mono text-xs" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Calling from</span>
          <Input
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            disabled={busy}
            placeholder="Withheld — or a number like +34612345000"
            className="tabular"
          />
        </label>
      </div>
    </div>
  );
}
