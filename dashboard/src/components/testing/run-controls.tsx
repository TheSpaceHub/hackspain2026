import { Bot, Play, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { RunRequest, SuiteResponse } from '@/lib/testlab/types';

interface RunControlsProps {
  suite: SuiteResponse;
  busy: boolean;
  onRun: (req: RunRequest) => void;
}

/**
 * What to run, and who rings. A problem is the unit people think in, so the
 * picker is a list of the eighteen; the behaviours multiply whatever is picked,
 * which is how "all of problem 6, from someone who will not listen" is expressed.
 */
export function RunControls({ suite, busy, onRun }: RunControlsProps) {
  const [problems, setProblems] = useState<ReadonlySet<string>>(() => new Set());
  const [behaviours, setBehaviours] = useState<ReadonlySet<string>>(() => new Set(['cooperative']));
  const [mode, setMode] = useState<'persona' | 'script'>(suite.persona_caller ? 'persona' : 'script');
  const [concurrency, setConcurrency] = useState(4);

  const toggle = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const chosenCases = suite.problems
    .filter((p) => problems.size === 0 || problems.has(p.id))
    .reduce((n, p) => n + p.cases, 0);
  const calls = chosenCases * Math.max(1, behaviours.size);

  const run = (): void =>
    onRun({
      problem_ids: problems.size > 0 ? [...problems] : undefined,
      behaviours: [...behaviours],
      mode,
      concurrency,
    });

  return (
    <Card size="sm" className="min-h-0 overflow-y-auto">
      <CardHeader>
        <CardTitle>New run</CardTitle>
        <CardDescription>
          {problems.size === 0 ? 'Every problem' : `${problems.size} problem${problems.size === 1 ? '' : 's'}`} ·{' '}
          {chosenCases} cases · {behaviours.size} caller{behaviours.size === 1 ? '' : 's'} ·{' '}
          <span className="text-foreground">{calls} calls</span>
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'persona' | 'script')}>
            <TabsList aria-label="Caller">
              <TabsTrigger value="persona" className="px-3" disabled={!suite.persona_caller}>
                <Bot className="size-3.5" /> Persona
              </TabsTrigger>
              <TabsTrigger value="script" className="px-3">
                <ScrollText className="size-3.5" /> Script
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            at once
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
            >
              {[1, 2, 4, 6, 10, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          {mode === 'persona' && suite.persona_caller
            ? `A caller agent (${suite.persona_caller}) reads what the agent says and answers it.`
            : 'Fixed lines, in order — no model, and no reaction to what the agent says.'}
        </p>

        <Separator />

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Who is ringing</p>
          <div className="flex flex-wrap gap-1.5">
            {suite.behaviours.map((b) => {
              const on = behaviours.has(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  title={b.description}
                  onClick={() => setBehaviours((prev) => toggle(prev, b.id))}
                  className={cn(
                    'rounded-4xl border px-2.5 py-1 text-xs transition-colors',
                    on
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Problems</p>
            <Button variant="ghost" size="xs" onClick={() => setProblems(new Set())} disabled={problems.size === 0}>
              All
            </Button>
          </div>
          <ul className="flex flex-col gap-1">
            {suite.problems.map((p) => {
              const on = problems.size === 0 || problems.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    title={p.summary}
                    onClick={() => setProblems((prev) => toggle(prev, p.id))}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      on ? 'bg-muted/60 text-foreground' : 'text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{p.number}</span>
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <Badge variant={on ? 'secondary' : 'outline'}>{p.cases}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>

      <div className="px-(--card-spacing)">
        <Button className="w-full" onClick={run} disabled={busy || behaviours.size === 0}>
          <Play /> {busy ? 'Running…' : `Run ${calls} call${calls === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Card>
  );
}
