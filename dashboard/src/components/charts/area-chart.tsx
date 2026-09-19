import { type KeyboardEvent, type PointerEvent, useState } from 'react';
import { useElementWidth } from '@/hooks/use-element-width';
import { cn } from '@/lib/utils';

export interface AreaPoint {
  /** The bucket's start, ISO. */
  at: string;
  value: number;
  /** Extra rows for the tooltip, below the value: "with a record · 7". */
  detail?: { label: string; value: string }[];
}

interface AreaChartProps {
  points: AreaPoint[];
  /** What `value` counts, singular and plural: ["call", "calls"]. */
  unit: [string, string];
  formatX: (at: string) => string;
  /** The tooltip's heading for a bucket — usually its time span. */
  formatBucket: (at: string) => string;
  height?: number;
  label: string;
}

const PAD = { top: 12, right: 12, bottom: 28, left: 34 };

/** Round the top of the axis up to a clean step so ticks read 0 / 5 / 10 / 15. */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 4) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * One series over time: a 2px line over a 10% wash, hairline grid, and a crosshair
 * that snaps to the nearest bucket so the reader aims at a time, not at a line.
 * Arrow keys walk the buckets for anyone not using a pointer.
 */
export function AreaChart({ points, unit, formatX, formatBucket, height = 220, label }: AreaChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const { top, step } = niceScale(Math.max(0, ...points.map((p) => p.value)));
  const n = Math.max(1, points.length - 1);
  const x = (i: number): number => PAD.left + (points.length === 1 ? plotW / 2 : (i / n) * plotW);
  const y = (v: number): number => PAD.top + (1 - v / top) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = points.length
    ? `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
    : '';
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // About one x label per 90px, always including the last bucket.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 90))));
  const xTicks = points.map((_, i) => i).filter((i) => (points.length - 1 - i) % every === 0);

  const nearest = (clientX: number, rect: DOMRect): number => {
    const px = clientX - rect.left - PAD.left;
    return Math.max(0, Math.min(points.length - 1, Math.round((px / Math.max(1, plotW)) * n)));
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>): void => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((i) => {
      const from = i ?? points.length - 1;
      return Math.max(0, Math.min(points.length - 1, from + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  const a = active === null ? null : points[active];
  const tipLeft = active === null ? 0 : x(active);
  const flip = tipLeft > width - 180;

  return (
    <div
      ref={ref}
      className="relative outline-none focus-visible:rounded-lg focus-visible:ring-3 focus-visible:ring-ring/15"
      tabIndex={0}
      onKeyDown={onKey}
      onFocus={() => setActive((i) => i ?? points.length - 1)}
      onBlur={() => setActive(null)}
      role="img"
      aria-label={label}
    >
      {width > 0 && (
        <svg width={width} height={height} onPointerMove={onPointer} onPointerLeave={() => setActive(null)} className="block touch-none">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-neutral-200/80" strokeWidth={1} />
              <text x={PAD.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-muted-foreground text-[11px]">
                {t}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="tabular fill-muted-foreground text-[11px]">
              {formatX(points[i]!.at)}
            </text>
          ))}

          <path d={area} className="fill-brand-600/10" />
          <path d={line} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-brand-600" />

          {a && active !== null && (
            <g pointerEvents="none">
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={y(0)} className="stroke-neutral-300" strokeWidth={1} />
              <circle cx={x(active)} cy={y(a.value)} r={4.5} strokeWidth={2} className="fill-brand-600 stroke-card" />
            </g>
          )}
        </svg>
      )}

      {a && (
        <div
          className={cn(
            'pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border bg-popover px-3 py-2.5 shadow-md',
            flip ? '-translate-x-[calc(100%+12px)]' : 'translate-x-3',
          )}
          style={{ left: tipLeft }}
        >
          <p className="pb-1.5 text-xs text-muted-foreground">{formatBucket(a.at)}</p>
          <p className="flex items-center gap-2 text-sm">
            <span className="h-0.5 w-3 rounded-full bg-brand-600" />
            <span className="tabular font-semibold">{a.value}</span>
            <span className="text-muted-foreground">{a.value === 1 ? unit[0] : unit[1]}</span>
          </p>
          {a.detail?.map((d) => (
            <p key={d.label} className="flex items-center justify-between gap-4 pt-1 text-xs">
              <span className="text-muted-foreground">{d.label}</span>
              <span className="tabular font-medium">{d.value}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
