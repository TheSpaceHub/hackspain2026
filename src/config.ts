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
  agentMode: opt('AGENT_MODE', 'planner') as 'planner' | 'tools',
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
    /**
     * Offline, one call, ~24s of budget. Measured on the decider prompt: nemotron 2-8s,
     * deepseek-v4-pro 17-25s+, deepseek-v4-flash 78s — both deepseeks spend the budget
     * thinking and return nothing, so they floor every call regardless of how good the
     * reasoning would have been.
     */
    get deciderModel() {
      return opt('CLOUDFLARE_DECIDER_MODEL', '@cf/nvidia/nemotron-3-120b-a12b');
    },
    /**
     * The scratchpad extractor. It runs beside the call rather than inside a turn, so it
     * is picked for cost and not for latency; small is enough to copy a spelled-out DNI
     * out of one line of speech.
     */
    get extractorModel() {
      return opt('CLOUDFLARE_EXTRACTOR_MODEL', '@cf/meta/llama-3.1-8b-instruct-fast');
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
    // Flux is turn-based: it decides the caller has finished rather than waiting out a
    // silence timer, and tells us early enough to start generating before they have.
    sttModel: opt('DEEPGRAM_STT_MODEL', 'flux-general-multi'),
    ttsModel: opt('DEEPGRAM_TTS_MODEL', 'aura-2-thalia-en'),
    /** Hints, not a lock: callers switch between the two mid-sentence. */
    languageHints: opt('DEEPGRAM_LANGUAGE_HINTS', 'es,en').split(','),
    /** How sure Flux must be that the turn ended. Lower is faster and interrupts more. */
    eotThreshold: Number(opt('DEEPGRAM_EOT_THRESHOLD', '0.7')),
    /** Below it, generation starts on a guess and is thrown away if they keep talking. */
    eagerEotThreshold: Number(opt('DEEPGRAM_EAGER_EOT_THRESHOLD', '0.5')),
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

export const SILENCE_NUDGE_MS = 28_000;

export type Config = typeof config;
