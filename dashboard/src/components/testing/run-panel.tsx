import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { draftFix } from '@/lib/testlab/client';
import type { Case, FixPlan, Run } from '@/lib/testlab/types';
import { DetailBoundary } from './detail-boundary';
import { Markdown } from './markdown';
import { ResultDetail } from './result-detail';

/** The run as it happens: a bar, then a line per call, then the issues those calls add up to. */
export function RunPanel({
  run,
  cases,
  onStop,
}: {
  run: Run;
  /** The suite as it stands; a regenerated suite no longer holds an old run's cases. */
  cases: Map<string, Case>;
  onStop: (runId: string) => void;
}) {
  const [tab, setTab] = useState<'calls' | 'issues'>('calls');
  const [open, setOpen] = useState<string | null>(null);
  const [fixes, setFixes] = useState<Record<string, FixPlan | string>>({});
  const [drafting, setDrafting] = useState<string | null>(null);

  const askForFix = async (problemId: string): Promise<void> => {
    setDrafting(problemId);
    try {
      const plan = await draftFix(run.id, problemId);
      setFixes((prev) => ({ ...prev, [problemId]: plan }));
    } catch (err) {
      setFixes((prev) => ({ ...prev, [problemId]: String(err instanceof Error ? err.message : err) }));
    } finally {
      setDrafting(null);
    }
  };

  const pct = run.total === 0 ? 0 : Math.round((run.done / run.total) * 100);
  // Counted off the rows on screen, not off the progress stream: the stream is a call
  // ahead of the results, and a call that has finished but not arrived is neither.
  const passed = run.results.filter((r) => r.pass).length;
  const failed = run.results.length - passed;

  return (
    <Card size="sm" className="min-h-0 gap-3 overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {run.id}
          <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'running' ? 'brand' : 'secondary'}>
            {run.status}
          </Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {run.mode} caller, all at once: {[...run.behaviours, ...run.vocabularies].join(' + ').replace(/_/g, ' ')} ·{' '}
            {run.concurrency} calls at a time
          </span>
          <span className="ml-auto text-xs font-normal tabular-nums">
            <span className="text-emerald-600">{passed} passed</span>
            {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
            <span className="text-muted-foreground"> · {run.done}/{run.total}</span>
          </span>
          {run.status === 'running' && (
            <Button variant="outline" size="xs" onClick={() => onStop(run.id)} disabled={run.stopping}>
              {run.stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </CardTitle>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        {run.stopping && (
          <p className="mt-1 text-xs text-muted-foreground">
            Dialling no more — the calls already on the line are being let finish.
          </p>
        )}
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
              const key = `${r.case_id}-${r.behaviour}-${r.vocabulary}-${r.copy}`;
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
                    {r.vocabulary && r.vocabulary !== 'plain' && (
                      <Badge variant="outline">{r.vocabulary.replace(/_/g, ' ')}</Badge>
                    )}
                  </button>
                  {isOpen && (
                    <DetailBoundary key={key}>
                      <ResultDetail result={r} kase={cases.get(r.case_id)} />
                    </DetailBoundary>
                  )}
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
                  <Button
                    variant="outline"
                    size="xs"
                    title="Ask a model where in the code this lives and what to change"
                    disabled={drafting !== null}
                    onClick={() => void askForFix(issue.problem_id)}
                  >
                    <Wand2 /> {drafting === issue.problem_id ? 'Drafting…' : 'Draft a fix'}
                  </Button>
                </div>
                <Markdown className="px-3 py-2">{issue.body}</Markdown>
                {fixes[issue.problem_id] !== undefined &&
                  (typeof fixes[issue.problem_id] === 'string' ? (
                    <p className="border-t border-border/60 px-3 py-2 text-xs text-destructive">
                      {fixes[issue.problem_id] as string}
                    </p>
                  ) : (
                    <div className="border-t border-border/60 bg-muted/30">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className="text-xs font-medium">A fix, drafted</span>
                        <code className="text-xs text-muted-foreground">
                          {(fixes[issue.problem_id] as FixPlan).branch}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Copy the plan"
                          className="ml-auto"
                          onClick={() =>
                            void navigator.clipboard.writeText((fixes[issue.problem_id] as FixPlan).plan)
                          }
                        >
                          <Copy />
                        </Button>
                      </div>
                      <Markdown className="px-3 pb-2">{(fixes[issue.problem_id] as FixPlan).plan}</Markdown>
                      <p className="px-3 pb-2 text-xs text-muted-foreground">
                        Hand this to a coding agent on {(fixes[issue.problem_id] as FixPlan).branch} to write the
                        change and open the pull request.
                      </p>
                    </div>
                  ))}
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
