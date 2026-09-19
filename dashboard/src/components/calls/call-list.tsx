import { Inbox, PhoneOff, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type Call, callStatus } from '@/lib/agent/model';
import { dayKey, formatClock, formatDay, formatDuration, formatPhone } from '@/lib/format';
import { summariseOutcome } from '@/lib/outcome';
import { cn } from '@/lib/utils';
import { AlertIndicator } from './alerts';
import { EmptyState } from './empty-state';
import { OutcomeBadge } from './outcome-badge';

interface CallListProps {
  calls: Call[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}

/** A call matches on its id, its number (digits only, however it was typed) or its outcome. */
function matches(call: Call, query: string, now: number): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3 && call.fromNumber?.replace(/\D/g, '').includes(digits)) return true;
  if (call.id.toLowerCase().includes(q)) return true;
  const outcome = summariseOutcome(call, callStatus(call, now)).label.toLowerCase();
  const snake = q.replace(/\s+/g, '_');
  return outcome.includes(q) || call.outcomes.some((o) => o.action.includes(snake) || !!o.reason?.includes(snake));
}

function CallRow({ call, selected, onSelect, now }: { call: Call; selected: boolean; onSelect: () => void; now: number }) {
  const phone = formatPhone(call.fromNumber);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative flex w-full flex-col gap-1.5 border-b px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-muted' : 'hover:bg-muted/50',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-600" />}
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn('truncate text-sm', phone ? 'font-medium' : 'text-muted-foreground italic')}>
          {phone ?? 'Withheld number'}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <AlertIndicator alerts={call.alerts} />
          <span className="tabular text-xs text-muted-foreground">{formatClock(call.startedAt)}</span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <OutcomeBadge call={call} status={callStatus(call, now)} />
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          {formatDuration(call.durationMs)} · {call.turnCount} {call.turnCount === 1 ? 'turn' : 'turns'}
        </span>
      </div>
    </button>
  );
}

export function CallList({ calls, selectedId, onSelect, now }: CallListProps) {
  const [query, setQuery] = useState('');
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const flagged = useMemo(() => calls.filter((c) => (c.alerts?.length ?? 0) > 0).length, [calls]);

  const groups = useMemo(() => {
    const byDay = new Map<string, Call[]>();
    for (const call of calls.filter((c) => matches(c, query, now) && (!onlyAlerts || (c.alerts?.length ?? 0) > 0))) {
      const key = dayKey(call.startedAt);
      byDay.set(key, [...(byDay.get(key) ?? []), call]);
    }
    return [...byDay.values()];
  }, [calls, query, now, onlyAlerts]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-center justify-between gap-2 pl-1">
          <h2 className="font-heading text-base font-medium">
            Calls <span className="tabular text-xs font-normal text-muted-foreground">{calls.length}</span>
          </h2>
          <Button
            variant={onlyAlerts ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={onlyAlerts}
            onClick={() => setOnlyAlerts((on) => !on)}
            disabled={flagged === 0 && !onlyAlerts}
          >
            <TriangleAlert data-icon="inline-start" />
            With alerts <span className="tabular text-muted-foreground">{flagged}</span>
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Number, call id, outcome or reason"
            className="pl-9"
            aria-label="Filter calls"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {calls.length === 0 ? (
          <EmptyState icon={Inbox} title="No finished calls yet">
            Calls appear here the moment they end. Run <code className="font-mono text-xs">pnpm harness:local</code> to make one.
          </EmptyState>
        ) : groups.length === 0 ? (
          <EmptyState icon={PhoneOff} title="Nothing matches">
            {query ? `No call matches “${query}”${onlyAlerts ? ' with alerts' : ''}.` : 'No call has alerts.'}
          </EmptyState>
        ) : (
          groups.map((group) => (
            <section key={dayKey(group[0]!.startedAt)}>
              <h3 className="sticky top-0 z-10 border-b bg-card/90 px-3 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase backdrop-blur">
                {formatDay(group[0]!.startedAt, now)}
              </h3>
              {group.map((call) => (
                <CallRow key={call.id} call={call} selected={call.id === selectedId} onSelect={() => onSelect(call.id)} now={now} />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
