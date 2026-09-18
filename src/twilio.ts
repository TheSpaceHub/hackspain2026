/** Twilio Media Streams: camelCase, with sequenceNumber/chunk/timestamp as strings. */

export interface ConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface StartMessage {
  event: 'start';
  sequenceNumber: string;
  streamSid: string;
  start: {
    streamSid: string;
    accountSid?: string;
    /** The call_id; never mint one. */
    callSid: string;
    tracks?: string[];
    customParameters?: Record<string, string>;
    mediaFormat?: { encoding: string; sampleRate: number; channels: number };
  };
}

export interface MediaMessage {
  event: 'media';
  sequenceNumber: string;
  streamSid: string;
  media: {
    track?: string;
    chunk: string;
    timestamp: string;
    /** base64 µ-law, 8 kHz, 20 ms — 160 bytes. */
    payload: string;
  };
}

export interface StopMessage {
  event: 'stop';
  sequenceNumber: string;
  streamSid: string;
  stop?: { accountSid?: string; callSid?: string };
}

export interface MarkMessage {
  event: 'mark';
  streamSid: string;
  mark: { name: string };
}

export type InboundMessage =
  | ConnectedMessage
  | StartMessage
  | MediaMessage
  | StopMessage
  | MarkMessage
  | { event: string; [k: string]: unknown };

export function outboundMedia(streamSid: string, payload: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload } });
}

/** A no-op on their side today; free to send, and barge-in is local regardless. */
export function outboundClear(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid });
}

export function outboundMark(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

/** 8 kHz µ-law, 20 ms per frame. */
export const SAMPLE_RATE = 8000;
export const FRAME_BYTES = 160;
export const FRAME_MS = 20;
