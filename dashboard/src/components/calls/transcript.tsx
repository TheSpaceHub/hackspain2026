import { Headset, User } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Role, Turn } from '@/lib/agent/model';
import { cn } from '@/lib/utils';

/** Consecutive turns by the same speaker read as one block, like any chat. */
function groupTurns(turns: Turn[]): { role: Role; turns: Turn[] }[] {
  const groups: { role: Role; turns: Turn[] }[] = [];
  for (const turn of turns) {
    const last = groups[groups.length - 1];
    if (last && last.role === turn.role) last.turns.push(turn);
    else groups.push({ role: turn.role, turns: [turn] });
  }
  return groups;
}

const SPEAKER: Record<Role, { name: string; icon: typeof User }> = {
  user: { name: 'Caller', icon: User },
  assistant: { name: 'Agent', icon: Headset },
};

function Avatar({ role }: { role: Role }) {
  const { icon: Icon } = SPEAKER[role];
  return (
    <div
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full',
        role === 'assistant' ? 'bg-brand-600 text-white' : 'border bg-card text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" strokeWidth={2.25} />
    </div>
  );
}

function MessageGroup({ role, turns }: { role: Role; turns: Turn[] }) {
  const agent = role === 'assistant';
  return (
    <div className={cn('flex items-end gap-2.5', agent && 'flex-row-reverse')}>
      <Avatar role={role} />
      <div className={cn('flex max-w-[78%] flex-col gap-1', agent ? 'items-end' : 'items-start')}>
        <span className="px-1 text-xs font-medium text-muted-foreground">{SPEAKER[role].name}</span>
        {turns.map((turn, i) => {
          const last = i === turns.length - 1;
          return (
            <p
              key={turn.seq}
              className={cn(
                'rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap shadow-xs',
                agent ? 'border border-brand-100 bg-brand-50 text-neutral-900' : 'border bg-card',
                // The tail sits on the last bubble, on the speaker's side.
                last && (agent ? 'rounded-br-md' : 'rounded-bl-md'),
              )}
            >
              {turn.text || <span className="text-muted-foreground italic">(no words recognised)</span>}
            </p>
          );
        })}
      </div>
    </div>
  );
}

/** A centred rule with a label — the call's own events, between the messages. */
export function TimelineEvent({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function Transcript({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Nobody said anything on this call.</p>;
  }
  return (
    <div className="space-y-5">
      {groupTurns(turns).map((g) => (
        <MessageGroup key={g.turns[0]!.seq} role={g.role} turns={g.turns} />
      ))}
    </div>
  );
}
