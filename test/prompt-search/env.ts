/**
 * Boot order matters: the mock must be listening before `src/config.ts` is imported,
 * because that is where PROSPER_API_BASE_URL is read. Everything in `src/` therefore
 * arrives through the dynamic import below.
 */
import { initializeLogger } from '@livekit/agents';
import { existsSync } from 'node:fs';
import { startMock, type MockProsper } from './mock-server.js';

export interface SearchEnv {
  mock: MockProsper;
  rollout: typeof import('./rollout.js');
}

export async function bootEnv(): Promise<SearchEnv> {
  initializeLogger({ pretty: false, level: process.env.LOG_LEVEL ?? 'warn' });
  if (existsSync('.env')) process.loadEnvFile('.env');
  const mock = await startMock();
  process.env.PROSPER_API_BASE_URL = mock.baseUrl;
  process.env.PROSPER_API_KEY = 'prompt-search';
  process.env.DEEPGRAM_API_KEY ??= 'unused';
  const rollout = await import('./rollout.js');
  return { mock, rollout };
}
