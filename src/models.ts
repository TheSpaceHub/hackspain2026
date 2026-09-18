import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
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
 * Workers AI exposes an OpenAI-compatible surface, so the OpenAI plugin drops in
 * with a base URL swap. It speaks chat completions, not the Responses API — this
 * must be `openai.LLM`, never `openai.responses.LLM`.
 */
export function createLLM(): openai.LLM {
  return new openai.LLM({
    model: config.cloudflare.model,
    apiKey: config.cloudflare.apiToken,
    baseURL: config.cloudflare.baseURL,
    temperature: 0.3,
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
