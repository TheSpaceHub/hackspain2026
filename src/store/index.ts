import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import type { CallAlerts, QueryResult, StoreMessage } from './protocol.js';

/**
 * Handle to the central store. Writes are fire-and-forget postMessage: they cross to the
 * worker thread and never block the loop pacing 20ms audio frames.
 */
export class Store extends EventEmitter {
  #worker: Worker;
  #pending = new Map<number, (r: QueryResult) => void>();
  #nextId = 1;

  constructor(path: string) {
    super();
    this.setMaxListeners(0);
    mkdirSync(dirname(path), { recursive: true });
    // tsx registers its loader for workers too, so the .ts entry resolves as-is.
    const here = dirname(fileURLToPath(import.meta.url));
    this.#worker = new Worker(join(here, 'worker.ts'), { workerData: { path } });
    this.#worker.on('message', (msg: QueryResult | CallAlerts) => {
      // Alerts are derived in the worker; they reach the console like any other row.
      if (msg.type === 'call_alerts') {
        this.emit('row', msg);
        return;
      }
      this.#pending.get(msg.id)?.(msg);
      this.#pending.delete(msg.id);
    });
    this.#worker.on('error', (err) => console.error('[store] worker error', err));
    this.#worker.unref();
  }

  /**
   * Every row is also broadcast in-process, so a dashboard sees it at the moment it is
   * written rather than polling. Emitting is synchronous and in-memory; the durable write
   * still crosses to the worker thread.
   */
  write(msg: StoreMessage): void {
    if (msg.type !== 'query') this.emit('row', msg);
    try {
      this.#worker.postMessage(msg);
    } catch (err) {
      console.error(`[store] post failed: ${String(err)}`);
    }
  }

  query(
    name: 'recent' | 'call' | 'stats',
    opts: { call_id?: string; limit?: number; since?: string; bucket_ms?: number } = {},
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(null);
      }, 5_000);
      this.#pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r.error ? { error: r.error } : r.rows);
      });
      this.write({ type: 'query', id, name, ...opts });
    });
  }
}

export function openStore(): Store {
  return new Store(join(config.logDir, 'calls.db'));
}
