/**
 * The test lab, under /__testlab: the suite, the difficult callers, and the runs.
 *
 * It lives in the mock because the mock owns the world the cases were generated
 * against and the records they are graded on; the dashboard only needs a browser.
 *
 *   GET  /__testlab                 problems, cases and behaviours
 *   POST /__testlab/runs            {case_ids?, problem_ids?, behaviours?, mode?, concurrency?}
 *   GET  /__testlab/runs            every run, newest first
 *   GET  /__testlab/runs/:id        one run, with every result and the issue drafts
 *   GET  /__testlab/runs/:id/events one line per call as it settles (SSE)
 */
import { fail, ok, type Router, STREAMING } from '../http.js';
import type { Suite } from '../world/suite/index.js';
import { BEHAVIOURS } from '../../testlab/behaviour.js';
import { llmAvailable, llmName } from '../../testlab/llm.js';
import type { RunRequest, Runner } from '../../testlab/runner.js';

export function testlabRoutes(router: Router, suite: Suite, runner: Runner): void {
  router
    .get('/__testlab', () =>
      ok({
        problems: suite.problems.map((p) => ({ ...p, cases: suite.ofProblem(p.id).length })),
        // The expectations come too: the tab shows what a case wants before it runs.
        cases: suite.cases,
        behaviours: BEHAVIOURS,
        persona_caller: llmAvailable() ? llmName() : null,
      }),
    { public: true })
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
