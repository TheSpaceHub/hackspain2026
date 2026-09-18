import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { OpenAI } from 'openai';
import { config } from './config.js';

/**
 * Model construction. STT and TTS are per-call (each owns its own websocket to
 * Deepgram); the VAD model is loaded once at boot and shared, because it is a
 * stateless ONNX session and loading it twenty times would be twenty copies of
 * the same weights.
 */

export type SharedVad = Awaited<ReturnType<typeof silero.VAD.load>>;

export async function loadVad(): Promise<SharedVad> {
  return silero.VAD.load();
}

/**
 * Workers AI rejects `tools: []` outright:
 *
 *   `tools` must not be an empty array. Either provide at least one tool or
 *   omit the field entirely.
 *
 * The plugin sends the empty array whenever the agent has no tools, which in v0
 * is every single turn — so every reply came back 400 and the session closed on
 * an unrecoverable LLM error. OpenAI itself tolerates it, so this is a Workers AI
 * strictness rather than a plugin bug.
 *
 * Stripping it in the client is the narrow fix: no invented placeholder tool, and
 * the moment v1 gives the agent real tools the array stops being empty and this
 * stops doing anything.
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
      // Not JSON we understand; pass it through untouched.
    }
  }
  return fetch(input, init);
};

/**
 * Workers AI exposes an OpenAI-compatible surface, so the OpenAI plugin drops in
 * with a base URL swap. It speaks chat completions, not the Responses API — this
 * must be `openai.LLM`, never `openai.responses.LLM`.
 */
export function createLLM(): openai.LLM {
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

/** Deepgram takes 8 kHz µ-law audio directly, so nothing is upsampled on the way in. */
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
    // Digits come back as digits, which is what a DNI needs.
    numerals: true,
    // Close an utterance on a gap in the words, not only on silence detection.
    // Without it, a caller who stops mid-thought can leave a final transcript
    // unemitted until the next thing they say.
    utteranceEndMs: 1000,
    keyterm: keyterms,
  });
}

/**
 * Aura-2 at 8 kHz, which is the wire's rate, so nothing is resampled on the way out.
 *
 * Linear16 rather than mulaw, despite mulaw being the wire format. The plugin
 * pipes Deepgram's response bytes straight into an `AudioByteStream`, which
 * always interprets them as PCM16 — it never decodes µ-law. Asking for mulaw
 * therefore yields frames of µ-law bytes read as linear16: noise, at half the
 * duration. Verified against the plugin at 1.9.0.
 *
 * So we take real PCM16 here and `MediaStreamAudioOutput` does the µ-law
 * encoding itself, which it has to be able to do anyway.
 */
export function createTTS(): deepgram.TTS {
  return new deepgram.TTS({
    apiKey: config.deepgram.apiKey,
    model: config.deepgram.ttsModel,
    encoding: 'linear16',
    sampleRate: 8000,
  });
}
