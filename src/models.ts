import type { llm } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import * as anthropicPlugin from '@livekit/agents-plugin-anthropic';
import Anthropic from '@anthropic-ai/sdk';
import { OpenAI } from 'openai';
import { config } from './config.js';

/** STT and TTS are per-call (each owns a Deepgram socket); the VAD model is shared. */

export type SharedVad = Awaited<ReturnType<typeof silero.VAD.load>>;

export async function loadVad(): Promise<SharedVad> {
  return silero.VAD.load();
}

/**
 * Workers AI 400s on `tools: []`, which the plugin sends on every turn when the agent has
 * no tools — v0's every turn. No-ops once v1 has real tools.
 */
const stripEmptyTools: typeof fetch = async (input, init) => {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
        delete body.parallel_tool_calls;
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // not ours to touch
    }
  }
  return fetch(input, init);
};

/**
 * The plugin has no `output_config`, so effort is injected here. Without it a voice turn
 * runs at default effort and the caller hears dead air while the model thinks.
 */
function withEffort(effort: string): typeof fetch {
  return async (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body.output_config = { ...(body.output_config as object), effort };
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // not ours to touch
      }
    }
    return fetch(input, init);
  };
}

export function createAnthropicClient(effort: string): Anthropic {
  return new Anthropic({ apiKey: config.anthropic.apiKey, fetch: withEffort(effort) });
}

/** Claude when a key is present; Workers AI otherwise. */
export function createLLM(): llm.LLM {
  if (config.provider === 'anthropic') {
    return new anthropicPlugin.LLM({
      model: config.anthropic.model,
      temperature: 0.3,
      maxTokens: 300,
      client: createAnthropicClient(config.anthropic.callEffort),
    });
  }
  return new openai.LLM({
    model: config.cloudflare.model,
    temperature: 0.3,
    client: new OpenAI({
      apiKey: config.cloudflare.apiToken,
      baseURL: config.cloudflare.baseURL,
      fetch: stripEmptyTools,
    }),
  });
}

/** Deepgram takes 8 kHz directly; nothing is upsampled on the way in. */
export function createSTT(keyterms: string[]): deepgram.STT {
  return new deepgram.STT({
    apiKey: config.deepgram.apiKey,
    model: config.deepgram.sttModel,
    language: config.deepgram.language,
    sampleRate: 8000,
    numChannels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    // Digits as digits, which is what a DNI needs.
    numerals: true,
    // Close an utterance on a word gap, not only on silence.
    utteranceEndMs: 1000,
    keyterm: keyterms,
  });
}

/**
 * linear16, not mulaw: the plugin pipes response bytes into an AudioByteStream that always
 * reads PCM16 and never decodes µ-law, so mulaw yields noise at half duration (1.9.0).
 * MediaStreamAudioOutput encodes to µ-law instead.
 */
export function createTTS(): deepgram.TTS {
  return new deepgram.TTS({
    apiKey: config.deepgram.apiKey,
    model: config.deepgram.ttsModel,
    encoding: 'linear16',
    sampleRate: 8000,
  });
}
