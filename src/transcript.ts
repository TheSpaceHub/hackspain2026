import type { llm } from '@livekit/agents';

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/**
 * Flatten the session's ChatContext into what the decider reads: caller and agent
 * turns only, tool noise and system prompts dropped.
 */
export function buildCallTranscript(chatCtx: llm.ChatContext): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const item of chatCtx.items) {
    if (item.type !== 'message') continue;
    const role = item.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = item.textContent?.trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.role === 'user' ? 'Caller' : 'Agent'}: ${t.text}`)
    .join('\n');
}
