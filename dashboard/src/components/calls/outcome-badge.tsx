import { Badge, BadgeDot } from '@/components/ui/badge';
import type { Call, CallStatus } from '@/lib/agent/model';
import { summariseOutcome } from '@/lib/outcome';

export function OutcomeBadge({ call, status, className }: { call: Call; status: CallStatus; className?: string }) {
  const { label, tone, more } = summariseOutcome(call, status);
  return (
    <Badge variant={tone} className={className}>
      <BadgeDot />
      {label}
      {more > 0 && <span className="opacity-70">+{more}</span>}
    </Badge>
  );
}
