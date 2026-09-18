import type { AudioFrame } from '@livekit/rtc-node';
import { voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';

/** Caller audio into the session. One per socket. Deepgram takes 8 kHz, so no resampling. */
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
      this.#ended = true;
    }
  }

  /** Ends the stream so STT can finalise its last utterance. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      // already closed
    }
  }
}
