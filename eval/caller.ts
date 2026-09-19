/**
 * Shared, frozen caller simulator for the five decision methods. Every method talks to
 * the same caller (same model, same prompt, temperature 0) so only the receptionist
 * side varies. Text only: no audio, no STT.
 *
 *   const caller = new SimCaller(c);
 *   let said = await caller.reply(undefined);       // caller opens
 *   while (said && !caller.hungUp) said = await caller.reply(receptionistLine);
 */
import { config } from '../src/config.js';

export interface PublicCase {
  id: string;
  problem_id: string;
  language: string;
  reference_time: string;
  caller_prompt: string;
  persona: { name: string; phone: string; turn_cap: number; spells_name_on_request: boolean };
  expected: { acceptable: { actions: Record<string, unknown>[] }[] };
}

const HANGUP = '[HANGUP]';

export class SimCaller {
  hungUp = false;
  turns = 0;
  readonly transcript: { role: 'caller' | 'receptionist'; text: string }[] = [];
  private readonly history: { role: 'system' | 'user' | 'assistant'; content: string }[];

  constructor(readonly c: PublicCase, private readonly model = process.env.EVAL_CALLER_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast') {
    this.history = [{
      role: 'system',
      content:
        `${c.caller_prompt}\n\n` +
        `You are on the phone with the clinic's receptionist. Speak only as the caller: one or two short spoken sentences per turn, no stage directions, no lists, no markdown. ` +
        `Never invent facts about yourself that are not in your instructions above; if asked for something you do not have, say so. ` +
        `${c.persona.spells_name_on_request ? 'If asked to spell a name, spell it letter by letter.' : 'If asked to spell a name, spell it letter by letter, sounding slightly annoyed.'} ` +
        `Today is ${c.reference_time.slice(0, 10)}. Reply in the language you were addressed in if the receptionist switches. ` +
        `When your business is finished (confirmed, refused with no alternative you want, or you have given up), say goodbye and end your line with the token ${HANGUP}.`,
    }];
  }

  /** Feeds the receptionist's line and returns the caller's reply (undefined once hung up / turn cap). */
  async reply(receptionistLine: string | undefined): Promise<string | undefined> {
    if (this.hungUp) return undefined;
    if (receptionistLine !== undefined) {
      this.transcript.push({ role: 'receptionist', text: receptionistLine });
      this.history.push({ role: 'user', content: receptionistLine });
    } else {
      this.history.push({ role: 'user', content: '(The line connects. The receptionist says:) Clínica Arenal, good morning, how can I help?' });
      this.transcript.push({ role: 'receptionist', text: 'Clínica Arenal, good morning, how can I help?' });
    }
    if (this.turns >= this.c.persona.turn_cap) { this.hungUp = true; return undefined; }
    this.turns++;

    const res = await fetch(`${config.cloudflare.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.cloudflare.apiToken}` },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 200, messages: this.history }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`caller model http ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let text = (json.choices?.[0]?.message?.content ?? '').trim();
    if (text.includes(HANGUP)) { this.hungUp = true; text = text.replace(HANGUP, '').trim(); }
    this.history.push({ role: 'assistant', content: text || '...' });
    this.transcript.push({ role: 'caller', text });
    return text;
  }
}
