import { Inbox, PhoneOff, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { type Call, callStatus } from '@/lib/agent/model';
import { dayKey, formatClock, formatDay, formatDuration, formatPhone } from '@/lib/format';
import { summariseOutcome } from '@/lib/outcome';
import { cn } from '@/lib/utils';
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
  return outcome.includes(q) || call.outcomes.some((o) => o.action.includes(q.replace(/\s+/g, '_')));
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
        <span className="tabular shrink-0 text-xs text-muted-foreground">{formatClock(call.startedAt)}</span>
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

  const groups = useMemo(() => {
    const byDay = new Map<string, Call[]>();
    for (const call of calls.filter((c) => matches(c, query, now))) {
      const key = dayKey(call.startedAt);
      byDay.set(key, [...(byDay.get(key) ?? []), call]);
    }
    return [...byDay.values()];
  }, [calls, query, now]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="font-heading text-base font-medium">Calls</h2>
          <span className="tabular text-xs text-muted-foreground">{calls.length} total</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Number, call id or outcome"
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
            No call matches “{query}”.
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
