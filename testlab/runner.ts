/**
 * A run: some subset of the suite, dialled against the agent, graded on what
 * reached the local Prosper, and read for what to do next.
 *
 * Runs live in memory in the mock process — it already owns the world the cases
 * were generated against and the records they are graded on. Progress is pushed
 * to whoever is listening as each call settles, so the dashboard can show a run
 * of seventy calls arriving rather than a spinner.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Case, Grade } from '../mock/world/suite/types.js';
import { gradeRecord, leaks } from '../mock/world/suite/types.js';
import type { Suite } from '../mock/world/suite/index.js';
import { type Behaviour, blendBehaviours } from './behaviour.js';
import { atDifficulty, difficultyOf } from './difficulty.js';
import { dial } from './dial.js';
import { AgentFeed } from './feed.js';
import { type CaseResult, insightsFor, issueDrafts, type IssueDraft, summarise } from './insights.js';
import type { Shipment } from './ship.js';
import { blendVocabularies, type Vocabulary } from './vocabulary.js';

export interface RunRequest {
  case_ids?: string[];
  problem_ids?: string[];
  mode?: 'script' | 'persona';
  /** Difficult callers, blended into one person: talks over *and* will not listen. */
  behaviours?: string[];
  /** And one way of talking, likewise blended: vague *and* code-switching. */
  vocabularies?: string[];
  /** How much work the caller is, at the same traits: easy, normal, hard, brutal. */
  difficulty?: string;
  /** Calls in flight at once. The platform's Run All is ten. */
  concurrency?: number;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface Run {
  id: string;
  status: RunStatus;
  mode: 'script' | 'persona';
  behaviours: string[];
  vocabularies: string[];
  difficulty: string;
  concurrency: number;
  started_at: string;
  finished_at: string | null;
  total: number;
  done: number;
  passed: number;
  /** Asked to stop, still letting the calls in flight finish. */
  stopping: boolean;
  error: string | null;
  cases: { case_id: string; problem_id: string; title: string; copies: number; behaviour: string; vocabulary: string }[];
  results: CaseResult[];
  issues: IssueDraft[];
  /** The Devin sessions started off this run's issues, one per problem fixed. */
  shipments: Shipment[];
}

export interface RunnerOptions {
  agentWs: string;
  agentHttp: string;
  mockUrl: string;
  outDir: string;
}

/** Finished runs are written here, so history survives restarting the mock. */
function historyDir(outDir: string): string {
  return join(outDir, 'runs');
}

const SETTLE_MS = 3_000;
const WINDOW_GRACE_MS = 40_000;

/**
 * Round-robin over the problems. A whole-suite round is the better part of an hour,
 * and dialled in suite order the first quarter of it is all problem 1 — so the round
 * takes one case from each problem in turn and has something to say about the whole
 * board early, whenever it is stopped or read.
 */
export function interleave<T extends { kase: { id: string; problem_id: string } }>(jobs: T[]): T[] {
  // A case is one unit, copies and all: the Switchboard means nothing if its twenty
  // copies are spread across the round instead of ringing at once.
  const groups: T[][] = [];
  for (const job of jobs) {
    const last = groups.at(-1);
    if (last && last[0]!.kase.id === job.kase.id) last.push(job);
    else groups.push([job]);
  }

  const queues = new Map<string, T[][]>();
  for (const group of groups) {
    const problem = group[0]!.kase.problem_id;
    queues.set(problem, [...(queues.get(problem) ?? []), group]);
  }

  const out: T[] = [];
  while (out.length < jobs.length) {
    for (const queue of queues.values()) {
      const next = queue.shift();
      if (next) out.push(...next);
    }
  }
  return out;
}

interface MockCall {
  actions: Record<string, unknown>[];
  last_received_at: string | null;
  window_open: boolean;
}

export class Runner extends EventEmitter {
  readonly #runs = new Map<string, Run>();
  readonly #stopping = new Set<string>();
  #next = 1;

  constructor(private suite: Suite, private readonly opts: RunnerOptions) {
    super();
    this.setMaxListeners(0);
    this.#load();
  }

  /** The suite changes when it is regenerated; runs already recorded do not. */
  useSuite(suite: Suite): void {
    this.suite = suite;
  }

  /** Earlier runs, off disk, newest id last so the counter carries on past them. */
  #load(): void {
    let files: string[];
    try {
      files = readdirSync(historyDir(this.opts.outDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const run = JSON.parse(readFileSync(join(historyDir(this.opts.outDir), file), 'utf8')) as Run;
        // A run that was in flight when the process died did not finish, and never will.
        if (run.status === 'running') run.status = 'stopped';
        run.vocabularies ??= ['plain'];
        run.difficulty ??= 'normal';
        run.shipments ??= [];
        run.stopping = false;
        this.#runs.set(run.id, run);
        const n = Number(run.id.replace(/\D/g, ''));
        if (Number.isFinite(n) && n >= this.#next) this.#next = n + 1;
      } catch {
        /* a half-written run from a kill -9 is not worth refusing to boot over */
      }
    }
  }

  #save(run: Run): void {
    try {
      mkdirSync(historyDir(this.opts.outDir), { recursive: true });
      writeFileSync(join(historyDir(this.opts.outDir), `${run.id}.json`), JSON.stringify(run));
    } catch (err) {
      console.warn(`[testlab] could not write ${run.id} to history: ${String(err)}`);
    }
  }

  list(): Omit<Run, 'results' | 'issues' | 'cases'>[] {
    return [...this.#runs.values()].map(({ results: _r, issues: _i, cases: _c, ...rest }) => rest).reverse();
  }

  /**
   * Remember that a problem has been handed to Devin, so a reload still links to
   * the session and the button does not start a second one for the same fault.
   */
  record(id: string, shipment: Shipment): void {
    const run = this.#runs.get(id);
    if (!run) return;
    run.shipments = [...run.shipments.filter((s) => s.problem_id !== shipment.problem_id), shipment];
    this.#save(run);
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  /** Lets the calls in flight finish and dials no more. */
  stop(id: string): Run | undefined {
    const run = this.#runs.get(id);
    if (run?.status === 'running') {
      this.#stopping.add(id);
      run.stopping = true;
      this.#emit(run, 'run_stopping', { run_id: id, in_flight: Math.min(run.concurrency, run.total - run.done) });
    }
    return run;
  }

  /** Picks the cases, opens the run, and returns before the first call is dialled. */
  start(req: RunRequest): Run {
    const cases = this.#choose(req);
    if (cases.length === 0) throw new Error('no cases matched');
    // The traits make one caller rather than one run each: picking "talks over" and
    // "won't listen" asks for the person who does both, not two calls.
    const difficulty = difficultyOf(req.difficulty);
    const behaviour = atDifficulty(blendBehaviours(req.behaviours ?? []), difficulty);
    const vocabulary = blendVocabularies(req.vocabularies ?? []);
    // A harder call is a longer one: the turns spent confirming are turns the case
    // did not budget for, and running out of them is not the agent's failure.
    const chosen = cases.map((kase) => ({
      kase: difficulty.extra_turns === 0
        ? kase
        : { ...kase, persona: { ...kase.persona, turn_cap: kase.persona.turn_cap + difficulty.extra_turns } },
      behaviour,
      vocabulary,
    }));
    const run: Run = {
      id: `run-${String(this.#next++).padStart(4, '0')}`,
      status: 'running',
      mode: req.mode === 'persona' ? 'persona' : 'script',
      behaviours: req.behaviours?.length ? [...new Set(req.behaviours)] : ['cooperative'],
      vocabularies: req.vocabularies?.length ? [...new Set(req.vocabularies)] : ['plain'],
      difficulty: difficulty.id,
      concurrency: Math.min(Math.max(1, req.concurrency ?? 4), 20),
      started_at: new Date().toISOString(),
      finished_at: null,
      // A Switchboard case is one case and twenty calls; both numbers matter.
      total: chosen.reduce((n, c) => n + Math.max(1, c.kase.burst), 0),
      done: 0,
      passed: 0,
      stopping: false,
      error: null,
      cases: chosen.map(({ kase, behaviour, vocabulary }) => ({
        case_id: kase.id,
        problem_id: kase.problem_id,
        title: kase.title,
        copies: Math.max(1, kase.burst),
        behaviour: behaviour.id,
        vocabulary: vocabulary.id,
      })),
      results: [],
      issues: [],
      shipments: [],
    };
    this.#runs.set(run.id, run);
    this.#emit(run, 'run_started', { run_id: run.id, total: run.total });
    void this.#execute(run, chosen);
    return run;
  }

  #choose(req: RunRequest): Case[] {
    if (req.case_ids?.length) {
      return req.case_ids.map((id) => {
        const kase = this.suite.byId.get(id);
        if (!kase) throw new Error(`no case ${id}`);
        return kase;
      });
    }
    if (req.problem_ids?.length) return req.problem_ids.flatMap((p) => this.suite.ofProblem(p));
    return this.suite.cases;
  }

  #emit(run: Run, event: string, data: unknown): void {
    this.emit('event', { run_id: run.id, event, data });
  }

  async #execute(run: Run, chosen: { kase: Case; behaviour: Behaviour; vocabulary: Vocabulary }[]): Promise<void> {
    const feed = new AgentFeed(this.opts.agentHttp);
    try {
      await feed.start();
    } catch (err) {
      run.status = 'failed';
      run.error = `cannot reach the agent at ${this.opts.agentHttp}: ${String(err)}`;
      run.finished_at = new Date().toISOString();
      this.#emit(run, 'run_finished', { run_id: run.id, error: run.error });
      return;
    }

    // A burst case is its own little Run All: every copy goes out together.
    const jobs = interleave(
      chosen.flatMap(({ kase, behaviour, vocabulary }) =>
        Array.from({ length: Math.max(1, kase.burst) }, (_, copy) => ({ kase, behaviour, vocabulary, copy })),
      ),
    );

    try {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(run.concurrency, jobs.length) }, async () => {
        for (;;) {
          const job = jobs[cursor++];
          if (!job || this.#stopping.has(run.id)) return;
          // One call blowing up is a finding, not the end of the round: the rest of
          // the cases still have something to say.
          const result = await this.#one(run, job, feed).catch((err: unknown) => this.#broken(run, job, err));
          run.results.push(result);
          run.done++;
          if (result.pass) run.passed++;
          this.#emit(run, 'case_finished', { run_id: run.id, done: run.done, total: run.total, result });
        }
      });
      await Promise.all(workers);

      // The verdicts are in; the reading of them costs a model call each, so it
      // happens once at the end and only for what failed.
      for (const result of run.results) {
        const kase = this.suite.byId.get(result.case_id);
        if (result.pass || !kase) continue;
        result.summary = await summarise(kase, result).catch(() => undefined);
      }
      run.issues = issueDrafts(run.results, this.suite.byId);
      run.status = this.#stopping.has(run.id) ? 'stopped' : 'done';
    } catch (err) {
      run.status = 'failed';
      run.error = String(err);
    } finally {
      this.#stopping.delete(run.id);
      run.stopping = false;
      feed.stop();
      run.finished_at = new Date().toISOString();
      this.#save(run);
      this.#emit(run, 'run_finished', {
        run_id: run.id,
        status: run.status,
        passed: run.passed,
        total: run.total,
        issues: run.issues.length,
        error: run.error,
      });
    }
  }

  /** A call that threw, written up as the failure it is so the round can carry on. */
  #broken(
    run: Run,
    job: { kase: Case; behaviour: Behaviour; vocabulary: Vocabulary; copy: number },
    err: unknown,
  ): CaseResult {
    const detail = String(err instanceof Error ? err.message : err);
    const grade: Grade = { pass: false, misses: [`the call itself failed: ${detail}`], variant: -1 };
    return {
      case_id: job.kase.id,
      problem_id: job.kase.problem_id,
      title: job.kase.title,
      behaviour: job.behaviour.id,
      vocabulary: job.vocabulary.id,
      copy: job.copy,
      pass: false,
      grade,
      actions: [],
      leaked: [],
      call: {
        call_id: '',
        from_number: job.kase.from_number,
        ok: false,
        error: detail,
        frames_sent: 0,
        frames_received: 0,
        ms_to_first_audio: null,
        clears: 0,
        caller: run.mode,
        behaviour: job.behaviour.id,
        vocabulary: job.vocabulary.id,
        caller_prompt: null,
        caller_turns: [],
        transcript: [],
        wav_path: null,
        call_ms: 0,
      },
      insights: [
        {
          code: 'call_failed',
          severity: 'blocker',
          detail: `The call could not be made or did not survive: ${detail}`,
          why: 'The lab threw before the call could be graded, so this is the harness or the agent process, not a decision the agent made.',
          suggestion: 'Check the agent is up and reachable, then run this case again on its own.',
          evidence: [],
        },
      ],
    };
  }

  async #one(
    run: Run,
    job: { kase: Case; behaviour: Behaviour; vocabulary: Vocabulary; copy: number },
    feed: AgentFeed,
  ): Promise<CaseResult> {
    const { kase, behaviour, vocabulary, copy } = job;
    this.#emit(run, 'case_started', {
      run_id: run.id,
      case_id: kase.id,
      copy,
      title: kase.title,
      behaviour: behaviour.id,
      vocabulary: vocabulary.id,
    });
    const call = await dial({
      agentWs: this.opts.agentWs,
      mockUrl: this.opts.mockUrl,
      kase,
      mode: run.mode,
      behaviour,
      vocabulary,
      feed,
      outDir: this.opts.outDir,
      copy,
    });
    const record = await this.#record(call.call_id);
    const actions = record?.actions ?? [];
    const grade: Grade = gradeRecord(kase.expected, actions);
    const said = call.transcript.filter((t) => t.role === 'assistant').map((t) => t.text);
    const leaked = leaks(kase.protected, said);
    const base: Omit<CaseResult, 'insights'> = {
      case_id: kase.id,
      problem_id: kase.problem_id,
      title: kase.title,
      behaviour: behaviour.id,
      vocabulary: vocabulary.id,
      copy,
      pass: grade.pass && leaked.length === 0,
      grade,
      actions,
      leaked,
      call,
    };
    feed.forget(call.call_id);
    return { ...base, insights: insightsFor(kase, base) };
  }

  /** The record once it has settled, or once the submission window has shut on it. */
  async #record(callId: string): Promise<MockCall | null> {
    const deadline = Date.now() + WINDOW_GRACE_MS;
    while (Date.now() < deadline) {
      const call = await fetch(`${this.opts.mockUrl}/__mock/calls/${callId}`)
        .then((r) => (r.ok ? (r.json() as Promise<MockCall>) : null))
        .catch(() => null);
      if (!call) return null;
      const settled = call.last_received_at !== null && Date.now() - Date.parse(call.last_received_at) > SETTLE_MS;
      if (!call.window_open || settled) return call;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return null;
  }
}
