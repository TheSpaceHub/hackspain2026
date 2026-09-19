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
import type { Case, Grade } from '../mock/world/suite/types.js';
import { gradeRecord, leaks } from '../mock/world/suite/types.js';
import type { Suite } from '../mock/world/suite/index.js';
import { type Behaviour, behaviourOf } from './behaviour.js';
import { dial } from './dial.js';
import { AgentFeed } from './feed.js';
import { type CaseResult, insightsFor, issueDrafts, type IssueDraft, summarise } from './insights.js';

export interface RunRequest {
  case_ids?: string[];
  problem_ids?: string[];
  mode?: 'script' | 'persona';
  /** Difficult callers: every chosen case is run once per behaviour named here. */
  behaviours?: string[];
  /** Calls in flight at once. The platform's Run All is ten. */
  concurrency?: number;
}

export type RunStatus = 'running' | 'done' | 'failed';

export interface Run {
  id: string;
  status: RunStatus;
  mode: 'script' | 'persona';
  behaviours: string[];
  concurrency: number;
  started_at: string;
  finished_at: string | null;
  total: number;
  done: number;
  passed: number;
  error: string | null;
  cases: { case_id: string; problem_id: string; title: string; copies: number; behaviour: string }[];
  results: CaseResult[];
  issues: IssueDraft[];
}

export interface RunnerOptions {
  agentWs: string;
  agentHttp: string;
  mockUrl: string;
  outDir: string;
}

const SETTLE_MS = 3_000;
const WINDOW_GRACE_MS = 40_000;

interface MockCall {
  actions: Record<string, unknown>[];
  last_received_at: string | null;
  window_open: boolean;
}

export class Runner extends EventEmitter {
  readonly #runs = new Map<string, Run>();
  #next = 1;

  constructor(private readonly suite: Suite, private readonly opts: RunnerOptions) {
    super();
    this.setMaxListeners(0);
  }

  list(): Omit<Run, 'results' | 'issues' | 'cases'>[] {
    return [...this.#runs.values()].map(({ results: _r, issues: _i, cases: _c, ...rest }) => rest).reverse();
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  /** Picks the cases, opens the run, and returns before the first call is dialled. */
  start(req: RunRequest): Run {
    const cases = this.#choose(req);
    if (cases.length === 0) throw new Error('no cases matched');
    const behaviours = (req.behaviours?.length ? req.behaviours : ['cooperative']).map(behaviourOf);
    // Every case against every behaviour: the same want, a different person asking.
    const chosen = behaviours.flatMap((behaviour) => cases.map((kase) => ({ kase, behaviour })));
    const run: Run = {
      id: `run-${String(this.#next++).padStart(4, '0')}`,
      status: 'running',
      mode: req.mode === 'persona' ? 'persona' : 'script',
      behaviours: behaviours.map((b) => b.id),
      concurrency: Math.min(Math.max(1, req.concurrency ?? 4), 20),
      started_at: new Date().toISOString(),
      finished_at: null,
      // A Switchboard case is one case and twenty calls; both numbers matter.
      total: chosen.reduce((n, c) => n + Math.max(1, c.kase.burst), 0),
      done: 0,
      passed: 0,
      error: null,
      cases: chosen.map(({ kase, behaviour }) => ({
        case_id: kase.id,
        problem_id: kase.problem_id,
        title: kase.title,
        copies: Math.max(1, kase.burst),
        behaviour: behaviour.id,
      })),
      results: [],
      issues: [],
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

  async #execute(run: Run, chosen: { kase: Case; behaviour: Behaviour }[]): Promise<void> {
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
    const jobs = chosen.flatMap(({ kase, behaviour }) =>
      Array.from({ length: Math.max(1, kase.burst) }, (_, copy) => ({ kase, behaviour, copy })),
    );

    try {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(run.concurrency, jobs.length) }, async () => {
        for (;;) {
          const job = jobs[cursor++];
          if (!job) return;
          const result = await this.#one(run, job.kase, job.behaviour, job.copy, feed);
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
        if (result.pass) continue;
        result.summary = await summarise(this.suite.byId.get(result.case_id)!, result);
      }
      run.issues = issueDrafts(run.results);
      run.status = 'done';
    } catch (err) {
      run.status = 'failed';
      run.error = String(err);
    } finally {
      feed.stop();
      run.finished_at = new Date().toISOString();
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

  async #one(run: Run, kase: Case, behaviour: Behaviour, copy: number, feed: AgentFeed): Promise<CaseResult> {
    this.#emit(run, 'case_started', {
      run_id: run.id,
      case_id: kase.id,
      copy,
      title: kase.title,
      behaviour: behaviour.id,
    });
    const call = await dial({
      agentWs: this.opts.agentWs,
      mockUrl: this.opts.mockUrl,
      kase,
      mode: run.mode,
      behaviour,
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
