import { type CSSProperties, useMemo } from 'react';
import { shortId } from '@/lib/format';
import { callHue, minuteLabel } from '@/lib/sim/model';
import type { DiaryDay, DiaryProvider, Hold } from '@/lib/sim/wire';
import { cn } from '@/lib/utils';

const CELL_MIN = 15;

interface DiaryGridProps {
  diary: DiaryDay;
  /** Live holds on this day — from the stream, which moves before the diary refetches. */
  holds: Hold[];
  now: number;
  onOpenCall: (callId: string) => void;
}

type RunKind = 'off' | 'free' | 'snapshot' | 'booked' | 'held';

/** A stretch of consecutive cells that read the same: one appointment, one hold, a free hour. */
interface Run {
  minute: number;
  cells: number;
  kind: RunKind;
  /** What makes two neighbouring cells the same run. */
  key: string;
  title: string;
  callId: string | null;
  label: string | null;
}

function runsFor(p: DiaryProvider, diary: DiaryDay, holds: Hold[], from: number, to: number, now: number): Run[] {
  const working = new Map(p.on_leave ? [] : p.working.map((w) => [w.minute, w.location]));
  const taken = new Map(p.taken.map((t) => [t.minute, t.ref]));
  const appts = new Map(diary.appointments.map((a) => [a.appointment_id, a]));
  const held = new Map<number, Hold>();
  for (const h of holds) {
    if (h.provider_id !== p.provider_id) continue;
    for (let i = 0; i < h.cells; i++) held.set(h.minute + i * CELL_MIN, h);
  }

  const runs: Run[] = [];
  for (let m = from; m < to; m += CELL_MIN) {
    const ref = taken.get(m);
    const hold = held.get(m);
    const site = working.get(m);
    let next: Omit<Run, 'minute' | 'cells'>;
    if (ref) {
      const appt = appts.get(ref);
      next = appt
        ? {
            kind: 'booked',
            key: `a:${ref}`,
            callId: appt.call_id,
            label: appt.patient_name ?? appt.appointment_id,
            title: `${appt.appointment_id} · ${appt.patient_name ?? appt.patient_id} · ${appt.appointment_type_id} · ${minuteLabel(m)}, ${appt.duration_minutes} min${appt.call_id ? ` · booked by call ${shortId(appt.call_id)}` : ''}`,
          }
        : { kind: 'snapshot', key: 's', callId: null, label: null, title: "busy in the clinic's own diary" };
    } else if (hold) {
      const left = Math.max(0, Math.round((hold.expires_at - now) / 1000));
      next = {
        kind: 'held',
        key: `h:${hold.hold_id}`,
        callId: hold.call_id,
        label: `hold · ${shortId(hold.call_id)}`,
        title: `${hold.hold_id} · held by call ${shortId(hold.call_id)} · ${hold.appointment_type_id} · ${minuteLabel(hold.minute)} · ${left}s left`,
      };
    } else if (site) {
      next = { kind: 'free', key: `f:${site}`, callId: null, label: null, title: `free · ${site}` };
    } else {
      next = { kind: 'off', key: 'o', callId: null, label: null, title: p.on_leave ? 'on leave' : 'not working' };
    }

    const last = runs[runs.length - 1];
    // Snapshot-busy cells are nameless, so a run of them is one block; free and off stretch too.
    if (last && last.key === next.key && last.minute + last.cells * CELL_MIN === m) last.cells += 1;
    else runs.push({ minute: m, cells: 1, ...next });
  }
  return runs.map((r) => ({ ...r, title: `${minuteLabel(r.minute)}–${minuteLabel(r.minute + r.cells * CELL_MIN)} · ${r.title}` }));
}

const KIND_CLASS: Record<RunKind, string> = {
  off: 'bg-transparent',
  free: 'bg-muted/70',
  snapshot: 'bg-foreground/15',
  booked: 'bg-brand-500/85 text-white',
  held: 'text-foreground',
};

/**
 * The wall calendar: a row per provider, a column per 15 minutes. Grey is the
 * clinic's own diary (snapshot), orange what our calls booked, and a coloured
 * outline a hold — one hue per call, so two callers fighting over a slot show as
 * two colours. Anything a call did opens that call.
 */
export function DiaryGrid({ diary, holds, now, onOpenCall }: DiaryGridProps) {
  // The day's span: the earliest and latest minute anyone works, is booked or is held — on the hour.
  const [from, to] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of diary.providers) {
      for (const w of p.working) {
        lo = Math.min(lo, w.minute);
        hi = Math.max(hi, w.minute + CELL_MIN);
      }
      for (const t of p.taken) {
        lo = Math.min(lo, t.minute);
        hi = Math.max(hi, t.minute + CELL_MIN);
      }
    }
    for (const h of holds) {
      lo = Math.min(lo, h.minute);
      hi = Math.max(hi, h.minute + h.cells * CELL_MIN);
    }
    if (!Number.isFinite(lo)) return [8 * 60, 20 * 60];
    return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60];
  }, [diary.providers, holds]);

  const columns = (to - from) / CELL_MIN;
  const hours: number[] = [];
  for (let m = from; m < to; m += 60) hours.push(m);

  const providers = useMemo(
    () => [...diary.providers].sort((a, b) => a.specialty_name.localeCompare(b.specialty_name) || a.name.localeCompare(b.name)),
    [diary.providers],
  );

  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-max gap-y-1"
        style={{ gridTemplateColumns: `minmax(190px, max-content) repeat(${columns}, minmax(16px, 1fr))` }}
      >
        <div />
        {hours.map((m) => (
          <div
            key={m}
            className="tabular border-l border-border pl-1 text-[10px] leading-4 text-muted-foreground"
            style={{ gridColumn: `span ${Math.min(60 / CELL_MIN, (to - m) / CELL_MIN)}` }}
          >
            {minuteLabel(m)}
          </div>
        ))}

        {providers.map((p) => (
          <ProviderRow key={p.provider_id} provider={p} runs={runsFor(p, diary, holds, from, to, now)} onOpenCall={onOpenCall} />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({ provider: p, runs, onOpenCall }: { provider: DiaryProvider; runs: Run[]; onOpenCall: (callId: string) => void }) {
  const works = p.working.length > 0;
  return (
    <>
      <div className={cn('flex min-w-0 flex-col justify-center pr-3 leading-tight', !works && 'opacity-50')}>
        <span className="truncate text-xs font-medium">{p.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {p.provider_id} · {p.specialty_name}
          {p.on_leave && ' · on leave'}
        </span>
      </div>
      {runs.map((r) => {
        const hue = r.callId ? callHue(r.callId) : null;
        const clickable = r.callId !== null;
        const style: CSSProperties = { gridColumn: `span ${r.cells}` };
        if (r.kind === 'held' && hue !== null) {
          style.backgroundColor = `hsl(${hue} 80% 55% / 0.22)`;
          style.boxShadow = `inset 0 0 0 1.5px hsl(${hue} 70% 45%)`;
        }
        return (
          <button
            key={r.minute}
            type="button"
            disabled={!clickable}
            onClick={() => r.callId && onOpenCall(r.callId)}
            title={r.title}
            style={style}
            className={cn(
              'h-7 min-w-0 overflow-hidden rounded-sm px-1 text-left text-[10px] leading-7 whitespace-nowrap',
              KIND_CLASS[r.kind],
              r.kind === 'off' && 'rounded-none border-l border-border/40',
              clickable ? 'cursor-pointer hover:brightness-95' : 'cursor-default',
            )}
          >
            {r.label}
          </button>
        );
      })}
    </>
  );
}
