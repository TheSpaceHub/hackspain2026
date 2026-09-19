/**
 * The person on the other end of the line.
 *
 * Two of them: the script, which says its lines in order and is the fallback
 * whenever there is no model to call, and the persona — the platform's shape of
 * caller, given a description, private data and objectives, which reads what the
 * agent actually said and answers it. The persona is what makes problem 16 mean
 * anything: a caller who acts on a wrong fact has to have heard it first.
 */
import type { Case } from '../mock/world/suite/types.js';
import type { Behaviour } from './behaviour.js';
import { chat, llmAvailable, type Message } from './llm.js';

export interface Caller {
  readonly kind: 'script' | 'persona';
  /** The next thing they say, or null when they are done talking. */
  next(heard: string[]): Promise<string | null>;
}

class ScriptCaller implements Caller {
  readonly kind = 'script';
  #i = 0;
  constructor(private readonly lines: string[]) {}
  next(): Promise<string | null> {
    return Promise.resolve(this.#i < this.lines.length ? this.lines[this.#i++]! : null);
  }
}

const LANGUAGE: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  ca: 'Catalan',
};

class PersonaCaller implements Caller {
  readonly kind = 'persona';
  #history: Message[] = [];
  #turns = 0;

  constructor(
    private readonly kase: Case,
    private readonly behaviour: Behaviour,
    private readonly fallback: Caller,
  ) {}

  async next(heard: string[]): Promise<string | null> {
    if (this.#turns >= this.kase.persona.turn_cap) return null;
    const lastHeard = heard.at(-1) ?? '';
    this.#history.push({
      role: 'user',
      content: lastHeard === '' ? '(silence — the receptionist has said nothing)' : lastHeard,
    });
    let line: string;
    try {
      line = await chat([{ role: 'system', content: this.#system() }, ...this.#history], { maxTokens: 120 });
    } catch (err) {
      console.warn(`[testlab] persona fell back to the script: ${String(err)}`);
      return this.fallback.next(heard);
    }
    line = line.replace(/^["']|["']$/g, '').trim();
    if (line === '' || /^\(?hang ?up\)?$/i.test(line) || line.includes('<hangup>')) return null;
    this.#history.push({ role: 'assistant', content: line });
    this.#turns++;
    return line;
  }

  #system(): string {
    const p = this.kase.persona;
    const data = Object.entries(p.data).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    return [
      `You are ${p.name}, a member of the public ringing a clinic's reception. ${p.description}`,
      '',
      'What you know about yourself (give it only when it is asked for, the way a person would):',
      data || '  (nothing on paper)',
      '',
      'What you want from this call:',
      ...p.objectives.map((o) => `- ${o}`),
      '',
      `Speak ${LANGUAGE[this.kase.language] ?? 'English'}, one short spoken turn at a time — this is a phone call,`,
      'not a letter. No stage directions, no quotation marks, no explaining yourself to me.',
      'You are not the receptionist and you never do their job for them: you do not know the',
      'clinic\'s doctors, sites, rules or free slots, and you accept whatever they tell you about them.',
      ...(this.behaviour.instructions === '' ? [] : ['', `How you are on the phone: ${this.behaviour.instructions}`]),
      'When you have what you came for, or they have made it clear you cannot have it, say goodbye',
      'and then reply with exactly <hangup> on the turn after that.',
    ].join('\n');
  }
}

export function callerFor(kase: Case, mode: 'script' | 'persona', behaviour: Behaviour): Caller {
  const script = new ScriptCaller(kase.script);
  if (mode === 'script' || !llmAvailable()) return script;
  return new PersonaCaller(kase, behaviour, script);
}
