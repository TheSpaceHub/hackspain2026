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
      // Overridable to point the LLM path at a logging proxy or AI Gateway.
      return (
        process.env.CLOUDFLARE_AI_BASE_URL ||
        `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/ai/v1`
      );
    },
    /**
     * In-call. Measured time-to-first-token: llama-3.3-70b 427ms, deepseek-v4-pro 2151ms,
     * glm-5.3 1989ms. That gap is dead air the caller hears, and the persona talks over it.
     */
    get model() {
      return opt('CLOUDFLARE_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    },
    /** Offline, one call, 24s of budget — so it runs the strongest model available. */
    get deciderModel() {
      return opt('CLOUDFLARE_DECIDER_MODEL', '@cf/deepseek-ai/deepseek-v4-pro-0813');
    },
  },
  /**
   * Claude when a key is present, Cloudflare otherwise. The decider is one offline
   * call against a 24s budget, so it runs at full effort; a voice turn is judged on
   * time-to-first-word, so it runs low.
   */
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: opt('ANTHROPIC_MODEL', 'claude-opus-5'),
    deciderModel: opt('ANTHROPIC_DECIDER_MODEL', 'claude-opus-5'),
    callEffort: opt('ANTHROPIC_CALL_EFFORT', 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    deciderEffort: opt('ANTHROPIC_DECIDER_EFFORT', 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  },
  get provider(): 'anthropic' | 'cloudflare' {
    return config.anthropic.apiKey ? 'anthropic' : 'cloudflare';
  },
  deepgram: {
    apiKey: req('DEEPGRAM_API_KEY'),
    sttModel: opt('DEEPGRAM_STT_MODEL', 'nova-3'),
    ttsModel: opt('DEEPGRAM_TTS_MODEL', 'aura-2-thalia-en'),
    language: opt('DEEPGRAM_LANGUAGE', 'en'),
  },
  port: Number(opt('PORT', '7860')),
  logDir: opt('LOG_DIR', './calls'),

  /** The harness cuts at three minutes; we stop just inside it. */
  maxCallMs: 3 * 60_000,
  /** Closes 30s after the socket closes. */
  submitWindowMs: 30_000,
  /** Room for the POST and one retry inside the window. */
  submitReserveMs: 6_000,
} as const;

export type Config = typeof config;
