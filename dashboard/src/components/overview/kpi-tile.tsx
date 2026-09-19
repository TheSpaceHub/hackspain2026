import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Sparkline } from '@/components/charts/sparkline';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

/** One accent for every tile: the current step of its sparkline. */
const ACCENT = { stroke: 'stroke-brand-600', fill: 'fill-brand-600' };

interface KpiTileProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  /** One line under the figure: context, never a second headline. */
  hint?: ReactNode;
  trend?: (number | null)[];
  trendLabel?: string;
  /** The live tile says so. */
  pulse?: boolean;
}

export function KpiTile({ icon: Icon, label, value, hint, trend, trendLabel, pulse }: KpiTileProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {label}
          {pulse && (
            <Badge variant="brand">
              <span className="relative flex size-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/70" />
                <span className="relative size-1.5 rounded-full bg-brand-500" />
              </span>
              Live
            </Badge>
          )}
        </CardDescription>
        {/* Proportional figures: tabular digits look loose at display size. */}
        <CardTitle className="text-2xl font-semibold tracking-tight">{value}</CardTitle>
        <CardAction>
          <div className="flex size-8 items-center justify-center rounded-lg border text-muted-foreground">
            <Icon className="size-4" />
          </div>
        </CardAction>
      </CardHeader>
      <CardFooter className="items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">{hint}</p>
        {trend && <Sparkline values={trend} accent={ACCENT} label={trendLabel ?? `${label} trend`} />}
      </CardFooter>
    </Card>
  );
}
