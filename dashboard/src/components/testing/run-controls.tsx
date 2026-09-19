import { Bot, Dices, Play, ScrollText } from 'lucide-react';
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
  onRegenerate: (req: { seed: number; random: number }) => void;
}

/**
 * What to run, and who rings. A problem is the unit people think in, so the
 * picker is a list of the eighteen; the traits picked below make one caller
 * between them, which is how "all of problem 6, from someone who talks over you
 * and will not listen" is expressed — one call each, not one call per trait.
 */
export function RunControls({ suite, busy, onRun, onRegenerate }: RunControlsProps) {
  const [problems, setProblems] = useState<ReadonlySet<string>>(() => new Set());
  const [behaviours, setBehaviours] = useState<ReadonlySet<string>>(() => new Set(['cooperative']));
  const [mode, setMode] = useState<'persona' | 'script'>(suite.persona_caller ? 'persona' : 'script');
  const [vocabularies, setVocabularies] = useState<ReadonlySet<string>>(() => new Set(['plain']));
  const [concurrency, setConcurrency] = useState(4);
  const [confirmed, setConfirmed] = useState(false);
  const [seed, setSeed] = useState(suite.generation.seed);
  const [random, setRandom] = useState(suite.generation.random);

  const toggle = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const picked = suite.cases.filter((c) => problems.size === 0 || problems.has(c.problem_id));
  const chosenCases = picked.length;
  // The traits blend into one person, so a case is one call — except the Switchboard's,
  // which is the same case dialled several times at once.
  const calls = picked.reduce((n, c) => n + Math.max(1, c.burst), 0);
  const traits = suite.behaviours.filter((b) => behaviours.has(b.id));
  const voices = suite.vocabularies.filter((v) => vocabularies.has(v.id));

  // A big run costs minutes of real calls, and the default selection is every problem —
  // so anything past a couple of dozen asks first rather than starting on one click.
  const run = (): void => {
    if (calls > 24 && !confirmed) {
      setConfirmed(true);
      return;
    }
    setConfirmed(false);
    onRun({
      problem_ids: problems.size > 0 ? [...problems] : undefined,
      behaviours: [...behaviours],
      vocabularies: [...vocabularies],
      mode,
      concurrency,
    });
  };

  return (
    <Card size="sm" className="min-h-0 overflow-y-auto">
      <CardHeader>
        <CardTitle>New run</CardTitle>
        <CardDescription>
          {problems.size === 0 ? 'Every problem' : `${problems.size} problem${problems.size === 1 ? '' : 's'}`} ·{' '}
          {chosenCases} cases · one caller of {behaviours.size} trait{behaviours.size === 1 ? '' : 's'} ·{' '}
          <span className="text-foreground">{calls} calls</span>
          {calls !== chosenCases && ' (the Switchboard dials its case many times over)'}
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
          <p className="text-xs font-medium text-muted-foreground">Who is ringing</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Everything picked here is the same person: talks over <em>and</em> will not listen is one caller who does
            both, on every call — not a call each.
          </p>
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
          <p className="text-xs font-medium text-muted-foreground">How they talk</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Also blended into that one caller: vague <em>and</em> code-switching is one person doing both.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suite.vocabularies.map((v) => {
              const on = vocabularies.has(v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  title={v.description}
                  onClick={() => setVocabularies((prev) => toggle(prev, v.id))}
                  className={cn(
                    'rounded-4xl border px-2.5 py-1 text-xs transition-colors',
                    on
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          {traits.length + voices.length > 0 && (
            <p className="mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
              This run's caller: {[...traits, ...voices].map((t) => t.label.toLowerCase()).join(', ')}.
            </p>
          )}
          {mode === 'script' && vocabularies.size > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Scripts say the same words whoever is talking — how they talk only bites in persona mode.
            </p>
          )}
        </div>

        <Separator />

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Cases · {suite.generation.source === 'real' ? 'the real clinic' : 'the generated world'}
          </p>
          {suite.generation.source === 'real' ? (
            <>
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                  seed
                  <input
                    type="number"
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                  random asks
                  <input
                    type="number"
                    min={0}
                    max={60}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    value={random}
                    onChange={(e) => setRandom(Number(e.target.value))}
                  />
                </label>
                <Button variant="outline" size="sm" onClick={() => onRegenerate({ seed, random })} disabled={busy}>
                  <Dices /> Generate
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Four or five hand-written cases per problem, built on the clinic this mock is serving: the ask is
                fixed, the record they are graded against is computed from the diary as it stands, so they stay right
                as it moves.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                The random asks on top are arbitrary over the real patients — a doctor they have never seen, a day that
                may be closed. Most are impossible on purpose, and what is graded is whatever the live availability
                call answers. The same seed gives the same asks back; each case says which seed it came out of.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Four or five cases per problem, hand-written against the generated world: the ask is fixed, and the
              record each is graded against is computed from that world's own diary, so nothing is hard-coded. Start
              the mock with MOCK_MIRROR=1 to build them from the real clinic and add random asks on top.
            </p>
          )}
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
        <Button
          className="w-full"
          variant={confirmed ? 'destructive' : 'default'}
          onClick={run}
          disabled={busy || behaviours.size === 0 || vocabularies.size === 0}
        >
          <Play />{' '}
          {busy
            ? 'Running…'
            : confirmed
              ? `${calls} calls — press again to start`
              : `Run ${calls} call${calls === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Card>
  );
}
