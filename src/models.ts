import type { llm, stt } from '@livekit/agents';
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
 * Workers AI streams a delta that is a bare JSON number when the token is one — `11`,
 * not `"11"`. The plugin drops any content it does not recognise as a string, so every
 * number the agent says disappears: "I have :00 am, : am, or : am on Monday". Times,
 * dates and read-back identifiers all go the same way. Quote them on the way through.
 */
export function quoteNumericContent(chunk: Record<string, unknown>): void {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices as Record<string, unknown>[]) {
    for (const key of ['delta', 'message'] as const) {
      const part = choice[key] as Record<string, unknown> | undefined;
      if (part && typeof part.content === 'number') part.content = String(part.content);
    }
  }
}

/** Rewrites each `data:` line of an OpenAI-shaped SSE body, leaving framing alone. */
export function repairStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';

  const repairLine = (line: string): string => {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (payload === '' || payload === '[DONE]') return line;
    try {
      const chunk = JSON.parse(payload) as Record<string, unknown>;
      quoteNumericContent(chunk);
      return `data: ${JSON.stringify(chunk)}`;
    } catch {
      return line;
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (bytes, controller) => {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(repairLine).join('\n') + '\n'));
      },
      flush: (controller) => {
        if (pending !== '') controller.enqueue(encoder.encode(repairLine(pending)));
      },
    }),
  );
}

/**
 * Three Workers AI departures from the OpenAI shape, all fatal on a call:
 *
 * - it 400s on `tools: []`, which the plugin sends on every turn of a toolless agent;
 * - it 400s (empty body, no message) on an assistant turn whose `content` is `null` —
 *   which is exactly what it returns for a tool call, so replaying that turn with the
 *   tool result kills the second pass and the caller hears nothing after the lookup;
 * - it streams numeric tokens as numbers, and the plugin drops them.
 */
const workersAiQuirks: typeof fetch = async (input, init) => {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
        delete body.parallel_tool_calls;
      }
      if (Array.isArray(body.messages)) {
        for (const message of body.messages as Record<string, unknown>[]) {
          if (message.content === null || message.content === undefined) message.content = '';
        }
      }
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // not ours to touch
    }
  }
  const response = await fetch(input, init);
  if (!response.body) return response;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return new Response(repairStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    const parsed = (await response.json()) as Record<string, unknown>;
    quoteNumericContent(parsed);
    return new Response(JSON.stringify(parsed), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
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
      fetch: workersAiQuirks,
    }),
  });
}

/**
 * Deepgram takes 8 kHz directly; nothing is upsampled on the way in.
 *
 * Flux ends a turn by deciding the caller has finished rather than by waiting out a
 * silence timer, and flags it early enough (`eagerEotThreshold`) that the reply is
 * already being generated while they say their last word. On a nova-3 call that wait
 * was a second of dead air per turn. Non-Flux models keep the V1 socket.
 */
export function createSTT(keyterms: string[]): stt.STT {
  const model = config.deepgram.sttModel;
  if (model.startsWith('flux-')) {
    return new deepgram.STTv2({
      apiKey: config.deepgram.apiKey,
      model,
      // Only the multilingual Flux model takes hints; the English one rejects them.
      languageHint: model.endsWith('-multi') ? config.deepgram.languageHints : undefined,
      sampleRate: 8000,
      keyterms,
      // Digits as digits, which is what a DNI needs.
      numerals: true,
      eotThreshold: config.deepgram.eotThreshold,
      eagerEotThreshold: config.deepgram.eagerEotThreshold,
    });
  }

  return new deepgram.STT({
    apiKey: config.deepgram.apiKey,
    model,
    language: config.deepgram.languageHints[0],
    sampleRate: 8000,
    numChannels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
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
