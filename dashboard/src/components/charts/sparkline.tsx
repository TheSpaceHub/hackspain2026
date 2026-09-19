import { cn } from '@/lib/utils';

interface SparklineProps {
  /** Oldest first. Nulls are gaps in the data, bridged rather than drawn as zero. */
  values: (number | null)[];
  /** Tailwind stroke/fill classes for the current period — the accent. */
  accent: { stroke: string; fill: string };
  width?: number;
  height?: number;
  label: string;
}

/**
 * The trend behind a stat tile: history in the de-emphasis grey, the latest step
 * and its end-dot in the tile's accent. Decorative beside the number it sits by,
 * so it is labelled rather than made interactive.
 */
export function Sparkline({ values, accent, width = 104, height = 40, label }: SparklineProps) {
  const pts = values.flatMap((v, i) => (v === null ? [] : [{ i, v }]));
  const pad = 5; // room for the end-dot and its ring
  if (pts.length === 0) return <svg width={width} height={height} role="img" aria-label={`${label}: no data`} />;

  const max = Math.max(...pts.map((p) => p.v));
  const min = Math.min(...pts.map((p) => p.v));
  const span = max - min || 1;
  const n = Math.max(1, values.length - 1);
  const x = (i: number): number => pad + (i / n) * (width - pad * 2);
  // A flat series sits low rather than floating mid-air.
  const y = (v: number): number => (max === min ? height - pad - 4 : pad + (1 - (v - min) / span) * (height - pad * 2));

  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2];

  return (
    <svg width={width} height={height} role="img" aria-label={label} className="overflow-visible">
      <path d={path} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-neutral-300" />
      {prev && (
        <path
          d={`M${x(prev.i)},${y(prev.v)} L${x(last.i)},${y(last.v)}`}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          className={accent.stroke}
        />
      )}
      <circle cx={x(last.i)} cy={y(last.v)} r={4} strokeWidth={2} className={cn('stroke-card', accent.fill)} />
    </svg>
  );
}
