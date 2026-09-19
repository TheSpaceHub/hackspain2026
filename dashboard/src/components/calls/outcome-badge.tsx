import { Badge, BadgeDot } from '@/components/ui/badge';
import type { Call, CallStatus } from '@/lib/agent/model';
import { reasonLabel, summariseOutcome } from '@/lib/outcome';
import { cn } from '@/lib/utils';

export function OutcomeBadge({ call, status, className }: { call: Call; status: CallStatus; className?: string }) {
  const { label, reason, tone, more } = summariseOutcome(call, status);
  return (
    <Badge variant={tone} className={cn('max-w-full min-w-0 shrink', className)}>
      <BadgeDot />
      {label}
      {reason && <span className="truncate font-normal opacity-80">· {reasonLabel(reason)}</span>}
      {more > 0 && <span className="opacity-70">+{more}</span>}
    </Badge>
  );
}
