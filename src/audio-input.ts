import type { AudioFrame } from '@livekit/rtc-node';
import { voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';

/**
 * Caller audio, from the socket into the AgentSession.
 *
 * LiveKit's AudioInput is an abstract fan-in: we hand it one ReadableStream and
 * push a frame per inbound `media` message. Deepgram accepts 8 kHz directly, so
 * nothing is resampled on the way in.
 *
 * One instance per socket. It holds the controller for its own stream and
 * nothing else; there is no shared state to cross between calls.
 */
export class MediaStreamAudioInput extends voice.AudioInput {
  #controller: ReadableStreamDefaultController<AudioFrame> | null = null;
  #ended = false;

  constructor() {
    super();
    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.multiStream.addInputStream(source as never);
  }

  /** Push one decoded 20 ms frame of caller audio. */
  push(frame: AudioFrame): void {
    if (this.#ended) return;
    try {
      this.#controller?.enqueue(frame);
    } catch {
      // The consumer closed the stream first; nothing left to feed.
      this.#ended = true;
    }
  }

  /** The caller hung up: end the stream so STT can finalise its last utterance. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      // Already closed.
    }
  }
}
