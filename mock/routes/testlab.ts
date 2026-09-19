/**
 * The test lab, under /__testlab: the suite, the difficult callers, and the runs.
 *
 * It lives in the mock because the mock owns the world the cases were generated
 * against and the records they are graded on; the dashboard only needs a browser.
 *
 *   GET  /__testlab                 problems, cases, behaviours and vocabularies
 *   POST /__testlab/suite           {seed?, random?} rebuild the real-clinic suite
 *   POST /__testlab/runs            {case_ids?, problem_ids?, behaviours?, vocabularies?, mode?, concurrency?}
 *   GET  /__testlab/runs            every run, newest first
 *   GET  /__testlab/runs/:id        one run, with every result and the issue drafts
 *   POST /__testlab/runs/:id/stop   dial no more calls; the ones in flight still finish
 *   GET  /__testlab/runs/:id/events one line per call as it settles (SSE)
 */
import { fail, ok, type Router, STREAMING } from '../http.js';
import type { Suite } from '../world/suite/index.js';
import type { Generation } from '../world/suite/real/index.js';
import { BEHAVIOURS } from '../../testlab/behaviour.js';
import { llmAvailable, llmName } from '../../testlab/llm.js';
import type { RunRequest, Runner } from '../../testlab/runner.js';
import { VOCABULARIES } from '../../testlab/vocabulary.js';

/** The suite is replaceable at runtime, so the routes hold the box rather than the suite. */
export interface Lab {
  suite: Suite;
  generation: Generation;
  regenerate: (seed: number, random: number) => Promise<Suite>;
}

export function testlabRoutes(router: Router, lab: Lab, runner: Runner): void {
  const describe = (): Record<string, unknown> => ({
    problems: lab.suite.problems.map((p) => ({ ...p, cases: lab.suite.ofProblem(p.id).length })),
    // The expectations come too: the tab shows what a case wants before it runs.
    cases: lab.suite.cases,
    behaviours: BEHAVIOURS,
    vocabularies: VOCABULARIES,
    generation: lab.generation,
    persona_caller: llmAvailable() ? llmName() : null,
  });

  router
    .get('/__testlab', () => ok(describe()), { public: true })
    .post('/__testlab/suite', async ({ body }) => {
      const parsed = await body();
      const req = (parsed.ok ? (parsed.value ?? {}) : {}) as { seed?: number; random?: number };
      const seed = Number.isFinite(req.seed) ? Number(req.seed) : lab.generation.seed + 1;
      const random = Number.isFinite(req.random) ? Number(req.random) : lab.generation.random;
      try {
        await lab.regenerate(seed, Math.min(Math.max(0, random), 60));
        return ok(describe());
      } catch (err) {
        return fail(409, String(err instanceof Error ? err.message : err));
      }
    }, { public: true })
    .get('/__testlab/runs', () => ok({ runs: runner.list() }), { public: true })
    .post('/__testlab/runs', async ({ body }) => {
      const parsed = await body();
      const req = (parsed.ok ? (parsed.value ?? {}) : {}) as RunRequest;
      try {
        return ok(runner.start(req));
      } catch (err) {
        return fail(422, String(err instanceof Error ? err.message : err));
      }
    }, { public: true })
    .get('/__testlab/runs/:id', ({ params }) => {
      const run = runner.get(params.id!);
      return run ? ok(run) : fail(404, `no run ${params.id}`);
    }, { public: true })
    .post('/__testlab/runs/:id/stop', ({ params }) => {
      const run = runner.stop(params.id!);
      return run ? ok(run) : fail(404, `no run ${params.id}`);
    }, { public: true })
    .get('/__testlab/runs/:id/events', ({ params, req, res }) => {
      const run = runner.get(params.id!);
      if (!run) return fail(404, `no run ${params.id}`);
      const runId = params.id!;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ run_id: runId, done: run.done, total: run.total })}\n\n`);

      const onEvent = (msg: { run_id: string; event: string; data: unknown }): void => {
        if (msg.run_id !== runId) return;
        res.write(`event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`);
        if (msg.event === 'run_finished') res.end();
      };
      runner.on('event', onEvent);
      // Proxies drop an idle stream, and a slow call can be a minute of nothing.
      const beat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 15_000);
      const stop = (): void => {
        clearInterval(beat);
        runner.off('event', onEvent);
      };
      req.on('close', stop);
      res.on('error', stop);
      return STREAMING;
    }, { public: true });
}
