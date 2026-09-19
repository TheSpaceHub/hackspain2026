import { ArrowRight, ChevronRight, Inbox } from 'lucide-react';
import { EmptyState } from '@/components/calls/empty-state';
import { OutcomeBadge } from '@/components/calls/outcome-badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type Call, callStatus } from '@/lib/agent/model';
import { formatClock, formatDay, formatDuration, formatPhone } from '@/lib/format';

const ROWS = 6;

interface RecentCallsCardProps {
  calls: Call[];
  now: number;
  onOpen: (id: string) => void;
  onViewAll: () => void;
}

export function RecentCallsCard({ calls, now, onOpen, onViewAll }: RecentCallsCardProps) {
  const recent = calls.filter((c) => callStatus(c, now) !== 'live').slice(0, ROWS);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Recent calls</CardTitle>
        <CardDescription>The latest to finish — open one to read it</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onViewAll}>
            View all
            <ArrowRight data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <EmptyState icon={Inbox} title="No finished calls yet" />
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="pl-3">Time</TableHead>
                  <TableHead>Caller</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Length</TableHead>
                  <TableHead className="text-right">Turns</TableHead>
                  <TableHead className="w-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((call) => {
                  const phone = formatPhone(call.fromNumber);
                  return (
                    <TableRow
                      key={call.id}
                      onClick={() => onOpen(call.id)}
                      onKeyDown={(e) => e.key === 'Enter' && onOpen(call.id)}
                      tabIndex={0}
                      className="group cursor-pointer outline-none focus-visible:bg-muted/50"
                    >
                      <TableCell className="py-2.5 pl-3">
                        <span className="tabular font-medium">{formatClock(call.startedAt)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{formatDay(call.startedAt, now)}</span>
                      </TableCell>
                      <TableCell className={phone ? 'tabular' : 'text-muted-foreground italic'}>{phone ?? 'Withheld'}</TableCell>
                      <TableCell>
                        <OutcomeBadge call={call} status={callStatus(call, now)} />
                      </TableCell>
                      <TableCell className="tabular text-right">{formatDuration(call.durationMs)}</TableCell>
                      <TableCell className="tabular text-right">{call.turnCount}</TableCell>
                      <TableCell className="pr-3">
                        <ChevronRight className="ml-auto size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
