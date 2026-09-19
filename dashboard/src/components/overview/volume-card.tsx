import { ChartSpline, Table2 } from 'lucide-react';
import { useState } from 'react';
import { AreaChart } from '@/components/charts/area-chart';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Range, Stats } from '@/lib/agent/stats';
import { formatClock, formatDay } from '@/lib/format';

function bucketName(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return ms === 3_600_000 ? 'hour' : `${Math.round(ms / 3_600_000)} h`;
  return 'day';
}

export function VolumeCard({ stats, range }: { stats: Stats; range: Range }) {
  const [table, setTable] = useState(false);
  const daily = stats.bucket_ms >= 86_400_000;
  const formatX = (at: string): string => (daily ? formatDay(at) : formatClock(at));
  const formatBucket = (at: string): string =>
    daily ? formatDay(at) : `${formatDay(at)} · ${formatClock(at)}–${formatClock(new Date(Date.parse(at) + stats.bucket_ms).toISOString())}`;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Call volume</CardTitle>
        <CardDescription>{`Calls started ${range.phrase}, per ${bucketName(stats.bucket_ms)}`}</CardDescription>
        <CardAction>
          {/* Chart, or the same numbers as a table — the chart's accessible twin. */}
          <Tabs value={table ? 'table' : 'chart'} onValueChange={(v) => setTable(v === 'table')}>
            <TabsList>
              <TabsTrigger value="chart" aria-label="Show chart" title="Show chart">
                <ChartSpline />
              </TabsTrigger>
              <TabsTrigger value="table" aria-label="Show table" title="Show table">
                <Table2 />
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        {table ? (
          <div className="max-h-[220px] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-muted">
                <TableRow>
                  <TableHead className="pl-3">From</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="pr-3 text-right">With a record</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular">
                {[...stats.series].reverse().map((b) => (
                  <TableRow key={b.at}>
                    <TableCell className="pl-3 text-muted-foreground">{formatBucket(b.at)}</TableCell>
                    <TableCell className="text-right">{b.calls}</TableCell>
                    <TableCell className="pr-3 text-right">{b.with_record}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <AreaChart
            points={stats.series.map((b) => ({
              at: b.at,
              value: b.calls,
              detail: [{ label: 'with a record', value: String(b.with_record) }],
            }))}
            unit={['call', 'calls']}
            formatX={formatX}
            formatBucket={formatBucket}
            label={`Call volume ${range.phrase}: ${stats.totals.calls} calls`}
          />
        )}
      </CardContent>
    </Card>
  );
}
