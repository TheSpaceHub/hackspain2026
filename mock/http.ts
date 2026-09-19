/**
 * A small router over node:http — the mock needs path params, JSON in and out, and
 * the real API's key check, and nothing a framework would add.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON body; `undefined` when absent, a SyntaxError's message when malformed. */
  body: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

export interface Reply {
  status: number;
  body: unknown;
}

export type Handler = (ctx: Ctx) => Reply | Promise<Reply>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  public: boolean;
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
/** Every error the real API answers carries `detail`, a string or a validation list. */
export const fail = (status: number, detail: unknown): Reply => ({ status, body: { detail } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class Router {
  readonly #routes: Route[] = [];

  /** `public` routes skip the key check: /health and the schema, as on the real API. */
  add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-z_]+)/g, (_, k: string) => {
        keys.push(k);
        return '([^/]+)';
      })}/?$`,
    );
    this.#routes.push({ method, pattern, keys, handler, public: opts.public ?? false });
    return this;
  }

  get(path: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add('GET', path, handler, opts);
  }

  post(path: string, handler: Handler, opts?: { public?: boolean }): this {
    return this.add('POST', path, handler, opts);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const send = (reply: Reply): void => {
      res.writeHead(reply.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(reply.body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, X-Sim-Call-Id',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    const pathMatches = this.#routes.filter((r) => r.pattern.test(url.pathname));
    const route = pathMatches.find((r) => r.method === req.method);
    if (!route) {
      send(pathMatches.length ? fail(405, 'Method Not Allowed') : fail(404, 'Not Found'));
      return;
    }
    // Missing, invalid and revoked keys are all the same 403. The mock takes any key.
    if (!route.public && !req.headers['x-api-key']) {
      send(fail(403, 'Invalid API key'));
      return;
    }

    const m = route.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
    let cached: Awaited<ReturnType<Ctx['body']>> | undefined;
    const ctx: Ctx = {
      req,
      url,
      params,
      query: url.searchParams,
      body: async () => {
        if (cached) return cached;
        const text = await readBody(req);
        try {
          cached = { ok: true, value: text ? JSON.parse(text) : undefined };
        } catch (err) {
          cached = { ok: false, error: (err as Error).message };
        }
        return cached;
      },
    };

    try {
      send(await route.handler(ctx));
    } catch (err) {
      console.error(`[mock] ${req.method} ${url.pathname} failed`, err);
      send(fail(500, 'Internal Server Error'));
    }
  }
}

/** A query-parameter 422, shaped like the body ones. */
export function queryError(name: string, msg: string, type: string): Reply {
  return fail(422, [{ loc: ['query', name], msg, type }]);
}
