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
  onRegenerate: (req: { seed: number; random: number; viable: boolean }) => void;
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
  const [difficulty, setDifficulty] = useState('normal');
  const [concurrency, setConcurrency] = useState(4);
  const [confirmed, setConfirmed] = useState(false);
  const [seed, setSeed] = useState(suite.generation.seed);
  const [random, setRandom] = useState(suite.generation.random);
  const [viable, setViable] = useState(suite.generation.viable);

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
  const generated = suite.cases.filter((c) => c.id.startsWith('random-'));
  const levels = suite.difficulties ?? [];
  const level = levels.find((d) => d.id === difficulty);

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
      difficulty,
      mode,
      concurrency,
    });
  };

  /** Only the seeded asks, with the caller set up above. */
  const runGenerated = (): void => {
    onRun({
      case_ids: generated.map((c) => c.id),
      behaviours: [...behaviours],
      vocabularies: [...vocabularies],
      difficulty,
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
          <p className="mb-2 text-xs font-medium text-muted-foreground">How they talk</p>
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
          {mode === 'script' && vocabularies.size > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Persona mode only.</p>
          )}
        </div>

        {levels.length > 0 && (
          <>
            <Separator />

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Difficulty</p>
              <div className="flex flex-wrap gap-1.5">
                {levels.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    title={d.description}
                    onClick={() => setDifficulty(d.id)}
                    className={cn(
                      'rounded-4xl border px-2.5 py-1 text-xs transition-colors',
                      d.id === difficulty
                        ? 'border-transparent bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {level && level.id !== 'normal' && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {level.audio === null || level.audio.background === 'silence'
                    ? 'Clean line'
                    : `${level.audio.background} at ${level.audio.signal_to_noise_db} dB`}
                  , {level.accent === 'far' ? 'far accent' : 'local accent'}
                  {level.extra_turns > 0 ? `, +${level.extra_turns} turns` : ''}
                </p>
              )}
            </div>
          </>
        )}

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
                <Button variant="outline" size="sm" onClick={() => onRegenerate({ seed, random, viable })} disabled={busy}>
                  <Dices /> Generate
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={viable} onChange={(e) => setViable(e.target.checked)} />
                  Viable only
                  <span title="On: only asks the clinic can book. Off: impossible asks stay in and are graded on the refusal.">
                    {viable ? '(bookable asks)' : '(impossible asks too)'}
                  </span>
                </label>
                <Button
                  size="sm"
                  onClick={runGenerated}
                  disabled={busy || generated.length === 0 || behaviours.size === 0 || vocabularies.size === 0}
                  title="Run only the generated asks, with the caller set above"
                >
                  <Play /> Run {generated.length} generated
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Generated asks are listed under “The real call” below.</p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Start the mock with MOCK_MIRROR=1 for real-clinic cases.</p>
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
                    <span className="min-w-0 flex-1 truncate">
                      {p.title}
                      {p.id === 'the_real_call' && generated.length > 0 && (
                        <span className="text-xs text-muted-foreground"> · {generated.length} generated</span>
                      )}
                    </span>
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
