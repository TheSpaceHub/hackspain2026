import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { Run } from '@/lib/testlab/types';
import { ResultDetail } from './result-detail';

/** The run as it happens: a bar, then a line per call, then the issues those calls add up to. */
export function RunPanel({ run }: { run: Run }) {
  const [tab, setTab] = useState<'calls' | 'issues'>('calls');
  const [open, setOpen] = useState<string | null>(null);
  const pct = run.total === 0 ? 0 : Math.round((run.done / run.total) * 100);
  const failed = run.done - run.passed;

  return (
    <Card size="sm" className="min-h-0 gap-3 overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {run.id}
          <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'running' ? 'brand' : 'secondary'}>
            {run.status}
          </Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {run.mode} caller · {run.behaviours.join(', ')} · {run.concurrency} at once
          </span>
          <span className="ml-auto text-xs font-normal tabular-nums">
            <span className="text-emerald-600">{run.passed} passed</span>
            {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
            <span className="text-muted-foreground"> · {run.done}/{run.total}</span>
          </span>
        </CardTitle>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        {run.error && <p className="mt-1 text-xs text-destructive">{run.error}</p>}
      </CardHeader>

      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'calls' | 'issues')}>
          <TabsList aria-label="Run detail">
            <TabsTrigger value="calls" className="px-3">
              Calls
            </TabsTrigger>
            <TabsTrigger value="issues" className="px-3">
              Issues {run.issues.length > 0 && <Badge variant="secondary">{run.issues.length}</Badge>}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'calls' ? (
          <ul className="mt-3 flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
            {run.results.map((r) => {
              const key = `${r.case_id}-${r.behaviour}-${r.copy}`;
              const isOpen = open === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : key)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    )}
                    {r.pass ? (
                      <Check className="size-4 text-emerald-600" />
                    ) : (
                      <X className="size-4 text-destructive" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    {r.leaked.length > 0 && <CircleAlert className="size-4 text-destructive" />}
                    <span className="font-mono text-xs text-muted-foreground">{r.case_id}</span>
                    {r.behaviour !== 'cooperative' && <Badge variant="outline">{r.behaviour.replace(/_/g, ' ')}</Badge>}
                  </button>
                  {isOpen && <ResultDetail result={r} />}
                </li>
              );
            })}
            {run.results.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No call has settled yet — the first one takes about a minute.
              </li>
            )}
          </ul>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {run.issues.map((issue) => (
              <div key={issue.problem_id} className="rounded-md border border-border/60">
                <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{issue.title}</span>
                  {issue.labels.map((l) => (
                    <Badge key={l} variant="outline">
                      {l}
                    </Badge>
                  ))}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Copy the issue"
                    onClick={() => void navigator.clipboard.writeText(`# ${issue.title}\n\n${issue.body}`)}
                  >
                    <Copy />
                  </Button>
                </div>
                <pre className={cn('overflow-x-auto px-3 py-2 text-xs whitespace-pre-wrap')}>{issue.body}</pre>
              </div>
            ))}
            {run.issues.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {run.status === 'done' ? 'Nothing failed twice — no issue worth opening.' : 'Drafted when the run ends.'}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
