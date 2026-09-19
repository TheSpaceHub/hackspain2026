/**
 * Reflective prompt search over Ana's system prompt.
 *
 *   tsx test/prompt-search/search.ts [--gens 6] [--k 2] [--parallel 6] [--cases simple,cancel]
 *                                    [--out prompt-search-runs/<stamp>] [--seed-prompt file]
 *
 * Loop: evaluate every candidate on the train cases K times each → keep the Pareto
 * frontier over per-case pass rates → pick a frontier prompt with failures → the
 * reflector reads those failing traces and proposes one minimal edit → check the
 * invariants → evaluate the child. Held-out cases are scored but never selected on.
 * Everything lands in --out as JSONL, plus a report and the best prompt as text.
 */
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCases, type SearchCase } from './cases.js';
import { bootEnv } from './env.js';
import { frozenSections, reflect, violations, type Invariants } from './reflect.js';
import type { Trace } from './rollout.js';

// --- args -------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1]!;
}

const GENS = Number(arg('gens', '6'));
const K = Number(arg('k', '2'));
const PARALLEL = Number(arg('parallel', '6'));
const CASE_FILTER = arg('cases', '').split(',').filter(Boolean);
const OUT = arg('out', join('prompt-search-runs', new Date().toISOString().replace(/[:.]/g, '-')));
const SEED_PROMPT = arg('seed-prompt', '');
const CALLER_MODEL = arg('caller-model', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
const REFLECTOR_MODEL = arg('reflector-model', '@cf/openai/gpt-oss-120b');
const MAX_TURNS = Number(arg('max-turns', '14'));

// --- types ------------------------------------------------------------------------

interface Candidate {
  id: string;
  parent: string | null;
  gen: number;
  prompt: string;
  words: number;
  diagnosis?: string;
  edit?: string;
  /** case name → passes out of K, train cases only. */
  train: Record<string, number>;
  heldOut: Record<string, number>;
  trainRate: number;
  heldOutRate: number;
  printedCalls: number;
  agentWordsPerCall: number;
}

// --- helpers ----------------------------------------------------------------------

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function rate(scores: Record<string, number>, k: number): number {
  const v = Object.values(scores);
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / (v.length * k);
}

/** a dominates b: at least as good on every train case, strictly better on one. */
function dominates(a: Candidate, b: Candidate): boolean {
  let strictly = false;
  for (const name of Object.keys(a.train)) {
    const x = a.train[name] ?? 0;
    const y = b.train[name] ?? 0;
    if (x < y) return false;
    if (x > y) strictly = true;
  }
  return strictly;
}

function frontier(pop: Candidate[]): Candidate[] {
  return pop.filter((c) => !pop.some((o) => o !== c && dominates(o, c)));
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

// --- main -------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const log = (line: string): void => {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  console.log(stamped);
  appendFileSync(join(OUT, 'search.log'), `${stamped}\n`);
};
const jsonl = (file: string, row: unknown): void => appendFileSync(join(OUT, file), `${JSON.stringify(row)}\n`);

const env = await bootEnv();
const allCases = buildCases(env.mock.scenarios).filter(
  (c) => CASE_FILTER.length === 0 || CASE_FILTER.includes(c.name) || CASE_FILTER.includes(c.family),
);
const train = allCases.filter((c) => !c.heldOut);
const heldOut = allCases.filter((c) => c.heldOut);
const baseline = SEED_PROMPT ? readFileSync(SEED_PROMPT, 'utf8') : env.rollout.BASELINE_PROMPT;
const invariants: Invariants = {
  frozen: frozenSections(env.rollout.BASELINE_PROMPT),
  maxWords: Math.round(env.rollout.BASELINE_PROMPT.split(/\s+/).length * 1.08),
};
const rolloutEnv = { baseUrl: env.mock.baseUrl, callerModel: CALLER_MODEL, maxTurns: MAX_TURNS };

log(`out=${OUT} gens=${GENS} k=${K} parallel=${PARALLEL} train=${train.length} heldOut=${heldOut.length}`);
log(`train cases: ${train.map((c) => c.name).join(', ')}`);

const traces = new Map<string, Trace[]>();

async function evaluate(c: Candidate): Promise<void> {
  const jobs: { c: SearchCase; rep: number }[] = [];
  for (const cs of [...train, ...heldOut]) for (let rep = 0; rep < K; rep++) jobs.push({ c: cs, rep });
  const started = Date.now();
  const results = await pool(jobs, PARALLEL, async ({ c: cs, rep }) => {
    const t = await env.rollout.rollout(c.prompt, c.id, cs, rolloutEnv);
    jsonl('traces.jsonl', { gen: c.gen, rep, ...t });
    log(`  ${c.id} ${cs.name}#${rep} ${t.pass ? 'PASS' : 'FAIL'}${t.pass ? '' : ` — ${t.misses.join('; ').slice(0, 140)}`}`);
    return t;
  });
  traces.set(c.id, results);
  c.train = Object.fromEntries(train.map((cs) => [cs.name, results.filter((t) => t.case === cs.name && t.pass).length]));
  c.heldOut = Object.fromEntries(heldOut.map((cs) => [cs.name, results.filter((t) => t.case === cs.name && t.pass).length]));
  c.trainRate = rate(c.train, K);
  c.heldOutRate = rate(c.heldOut, K);
  c.printedCalls = results.reduce((a, t) => a + t.printedCalls, 0);
  c.agentWordsPerCall = Math.round(results.reduce((a, t) => a + t.agentWords, 0) / Math.max(1, results.length));
  jsonl('candidates.jsonl', c);
  log(
    `${c.id}: train ${(c.trainRate * 100).toFixed(0)}% held-out ${(c.heldOutRate * 100).toFixed(0)}% ` +
      `printed=${c.printedCalls} words=${c.words} agentWords/call=${c.agentWordsPerCall} (${Math.round((Date.now() - started) / 1000)}s)`,
  );
}

const population: Candidate[] = [];
const root: Candidate = {
  id: 'p0',
  parent: null,
  gen: 0,
  prompt: baseline,
  words: baseline.split(/\s+/).length,
  train: {},
  heldOut: {},
  trainRate: 0,
  heldOutRate: 0,
  printedCalls: 0,
  agentWordsPerCall: 0,
};
await evaluate(root);
population.push(root);

let nextId = 1;
for (let gen = 1; gen <= GENS; gen++) {
  const front = frontier(population);
  const parents = front.filter((c) => c.trainRate < 1);
  if (parents.length === 0) {
    log(`gen ${gen}: every frontier prompt passes every train case at K=${K}; stopping`);
    break;
  }
  // Prefer parents with more room to improve, but keep some variety.
  const parent = Math.random() < 0.7 ? parents.reduce((a, b) => (b.trainRate > a.trainRate ? b : a)) : pick(parents);
  const parentTraces = traces.get(parent.id) ?? [];
  const failing = parentTraces.filter((t) => !t.pass && !t.heldOut);
  // One failing trace per case, most-informative first (fewest pipeline errors = agent's own doing).
  const byCase = new Map<string, Trace>();
  for (const t of failing.sort((a, b) => a.errors.length - b.errors.length)) if (!byCase.has(t.case)) byCase.set(t.case, t);
  const sample = [...byCase.values()].slice(0, 4);
  const passes = parentTraces.filter((t) => t.pass && !t.heldOut).slice(0, 2);
  log(`gen ${gen}: frontier=${front.map((c) => c.id).join(',')} parent=${parent.id} failing cases=${sample.map((t) => t.case).join(',')}`);

  let child: Candidate | null = null;
  for (let attempt = 0; attempt < 3 && !child; attempt++) {
    try {
      const r = await reflect(parent.prompt, sample, passes, REFLECTOR_MODEL);
      const bad = violations(r.prompt, invariants);
      jsonl('reflections.jsonl', { gen, parent: parent.id, attempt, ...r, violations: bad });
      if (bad.length > 0) {
        log(`  reflection rejected: ${bad.join('; ')}`);
        continue;
      }
      if (r.prompt === parent.prompt) {
        log('  reflection changed nothing');
        continue;
      }
      child = {
        id: `p${nextId++}`,
        parent: parent.id,
        gen,
        prompt: r.prompt,
        words: r.prompt.split(/\s+/).length,
        diagnosis: r.diagnosis,
        edit: r.edit,
        train: {},
        heldOut: {},
        trainRate: 0,
        heldOutRate: 0,
        printedCalls: 0,
        agentWordsPerCall: 0,
      };
      log(`  ${child.id} edit: ${r.edit.replace(/\s+/g, ' ').slice(0, 300)}`);
    } catch (err) {
      log(`  reflector failed: ${String(err).slice(0, 200)}`);
    }
  }
  if (!child) continue;
  await evaluate(child);
  population.push(child);
}

// --- report ------------------------------------------------------------------------

const ranked = [...population].sort(
  (a, b) => b.trainRate - a.trainRate || b.heldOutRate - a.heldOutRate || a.words - b.words,
);
const best = ranked[0]!;
writeFileSync(join(OUT, 'best-prompt.txt'), best.prompt);
const caseNames = [...train, ...heldOut].map((c) => c.name);
const table = [
  `| id | parent | gen | train | held-out | printed | words | ${caseNames.join(' | ')} |`,
  `|---|---|---|---|---|---|---|${caseNames.map(() => '---').join('|')}|`,
  ...population.map(
    (c) =>
      `| ${c.id} | ${c.parent ?? '-'} | ${c.gen} | ${(c.trainRate * 100).toFixed(0)}% | ${(c.heldOutRate * 100).toFixed(0)}% | ${c.printedCalls} | ${c.words} | ` +
      caseNames.map((n) => `${c.train[n] ?? c.heldOut[n] ?? 0}/${K}`).join(' | ') +
      ' |',
  ),
];
const report = [
  `# Prompt search — ${OUT}`,
  '',
  `Generations: ${GENS} · K=${K} · caller ${CALLER_MODEL} · reflector ${REFLECTOR_MODEL}`,
  `Frontier: ${frontier(population).map((c) => c.id).join(', ')} · best by train then held-out: **${best.id}**`,
  '',
  ...table,
  '',
  '## Edits',
  ...population
    .filter((c) => c.parent)
    .flatMap((c) => [`### ${c.id} ← ${c.parent}`, `**Diagnosis.** ${c.diagnosis ?? ''}`, '', `**Edit.** ${c.edit ?? ''}`, '']),
].join('\n');
writeFileSync(join(OUT, 'report.md'), report);
log(`done. best=${best.id} train=${(best.trainRate * 100).toFixed(0)}% held-out=${(best.heldOutRate * 100).toFixed(0)}% → ${join(OUT, 'best-prompt.txt')}`);

await env.mock.close();
process.exit(0);
