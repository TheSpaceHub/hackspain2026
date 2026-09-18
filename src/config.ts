import { existsSync } from 'node:fs';

/** Environment, read once at boot. Nothing here is per-call. */

// Node loads .env itself; no dotenv dependency.
if (existsSync('.env')) process.loadEnvFile('.env');

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  prosper: {
    baseUrl: opt('PROSPER_API_BASE_URL', 'https://hackspain.getprosperapp.com').replace(/\/+$/, ''),
    apiKey: req('PROSPER_API_KEY'),
  },
  cloudflare: {
    accountId: req('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: req('CLOUDFLARE_API_TOKEN'),
    get baseURL() {
      // Overridable so the whole LLM path can be pointed at a logging proxy or an
      // AI Gateway without touching code.
      return (
        process.env.CLOUDFLARE_AI_BASE_URL ||
        `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/ai/v1`
      );
    },
    /** Workers AI speaks chat completions, so openai.LLM (not openai.responses.LLM) drops straight in. */
    model: opt('CLOUDFLARE_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  },
  deepgram: {
    apiKey: req('DEEPGRAM_API_KEY'),
    sttModel: opt('DEEPGRAM_STT_MODEL', 'nova-3'),
    ttsModel: opt('DEEPGRAM_TTS_MODEL', 'aura-2-thalia-en'),
    language: opt('DEEPGRAM_LANGUAGE', 'en'),
  },
  port: Number(opt('PORT', '7860')),
  logDir: opt('LOG_DIR', './calls'),

  /** Hard call ceiling. The harness cuts at three minutes; we stop just inside it. */
  maxCallMs: 3 * 60_000,
  /** The submission window closes 30s after the socket closes. */
  submitWindowMs: 30_000,
  /** Leave the POST (and one retry) room inside the window. */
  submitReserveMs: 6_000,
} as const;

export type Config = typeof config;
