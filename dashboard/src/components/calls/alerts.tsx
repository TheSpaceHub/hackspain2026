import { OctagonAlert, TriangleAlert } from 'lucide-react';
import type { Alert } from '@/lib/agent/model';
import { cn } from '@/lib/utils';

/** Critical is lost whatever the case was — red. Warning is worth a look — orange. */
const LEVEL = {
  critical: { icon: OctagonAlert, text: 'text-red-700', panel: 'border-red-200 bg-red-50/70', title: 'text-red-800' },
  warning: { icon: TriangleAlert, text: 'text-brand-700', panel: 'border-brand-200 bg-brand-50/70', title: 'text-brand-800' },
} as const;

function worst(alerts: Alert[]): Alert['level'] {
  return alerts.some((a) => a.level === 'critical') ? 'critical' : 'warning';
}

/** An icon and a count for a list row or a card; nothing when the call is clean. */
export function AlertIndicator({ alerts, className }: { alerts: Alert[] | null; className?: string }) {
  if (!alerts?.length) return null;
  const { icon: Icon, text } = LEVEL[worst(alerts)];
  return (
    <span
      className={cn('tabular flex shrink-0 items-center gap-1 text-xs font-medium', text, className)}
      title={alerts.map((a) => a.title).join(' · ')}
      aria-label={`${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}: ${alerts.map((a) => a.title).join(', ')}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {alerts.length}
    </span>
  );
}

/** Every alert on a call, spelled out, critical first. */
export function AlertsPanel({ alerts }: { alerts: Alert[] | null }) {
  if (!alerts?.length) return null;
  const sorted = [...alerts].sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));
  return (
    <ul className="space-y-2">
      {sorted.map((a) => {
        const l = LEVEL[a.level];
        return (
          <li key={a.id} className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5', l.panel)}>
            <l.icon className={cn('mt-0.5 size-4 shrink-0', l.text)} aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p className={cn('text-sm font-medium', l.title)}>{a.title}</p>
              <p className="text-xs leading-relaxed text-foreground/80">{a.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The agent turns an alert points at, for the transcript to mark. */
export function flaggedSeqs(alerts: Alert[] | null): ReadonlySet<number> {
  return new Set((alerts ?? []).flatMap((a) => a.seqs ?? []));
}
