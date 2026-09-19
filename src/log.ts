import { AsyncLocalStorage } from 'node:async_hooks';
import { pino } from 'pino';
import { build } from 'pino-pretty';

export const callContext = new AsyncLocalStorage<string>();

function tag(): string {
  const id = callContext.getStore();
  const at = new Date().toISOString().slice(11, 23);
  return id ? `[${at}] [call ${id.slice(0, 8)}] ` : `[${at}] `;
}

export const clog = {
  info: (msg: string) => console.log(tag() + msg),
  warn: (msg: string) => console.warn(tag() + msg),
  error: (msg: string) => console.error(tag() + msg),
};

// Symbol key is defined by @livekit/agents/dist/log_core.js.
export function tagLiveKitLogger(level: string): void {
  const logger = pino(
    {
      level,
      serializers: { error: pino.stdSerializers.err },
      mixin: () => {
        const id = callContext.getStore();
        return id ? { call: id.slice(0, 8) } : {};
      },
    },
    build({ colorize: true }),
  );
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('@livekit/agents:logger')] = logger;
}
