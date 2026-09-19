/**
 * What the agent said, as it says it.
 *
 * The agent already broadcasts every turn it writes down on /events; the lab
 * listens to that one stream instead of running a second transcriber, so a
 * persona caller replies to the agent's actual words with no extra STT.
 */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

interface Waiter {
  after: number;
  resolve: (turns: Turn[]) => void;
  timer: NodeJS.Timeout;
}

export class AgentFeed {
  readonly #turns = new Map<string, Turn[]>();
  readonly #waiting = new Map<string, Waiter[]>();
  #controller: AbortController | null = null;
  #connected: Promise<void> | null = null;

  constructor(private readonly origin: string) {}

  /** Resolves once the stream is open, so no call is dialled before anyone is listening. */
  start(): Promise<void> {
    this.#connected ??= this.#run();
    return this.#connected;
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#connected = null;
  }

  turns(callId: string): Turn[] {
    return this.#turns.get(callId) ?? [];
  }

  said(callId: string): string[] {
    return this.turns(callId).filter((t) => t.role === 'assistant').map((t) => t.text);
  }

  forget(callId: string): void {
    this.#turns.delete(callId);
    this.#waiting.delete(callId);
  }

  /**
   * The agent's reply to what was just said: every assistant turn written after
   * `after`, once it has stopped adding to them. Returns empty on a mute agent,
   * which is the failure we want recorded rather than waited out.
   */
  nextReply(callId: string, after: number, timeoutMs = 12_000): Promise<Turn[]> {
    const already = this.turns(callId).filter((t) => t.role === 'assistant' && t.at > after);
    if (already.length > 0) return Promise.resolve(already);
    return new Promise((resolve) => {
      const list = this.#waiting.get(callId) ?? [];
      const waiter: Waiter = {
        after,
        resolve,
        timer: setTimeout(() => {
          this.#drop(callId, waiter);
          resolve([]);
        }, timeoutMs),
      };
      list.push(waiter);
      this.#waiting.set(callId, list);
    });
  }

  #drop(callId: string, waiter: Waiter): void {
    const list = this.#waiting.get(callId);
    if (!list) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
  }

  #record(callId: string, turn: Turn): void {
    const turns = this.#turns.get(callId) ?? [];
    turns.push(turn);
    this.#turns.set(callId, turns);
    if (turn.role !== 'assistant') return;
    for (const waiter of [...(this.#waiting.get(callId) ?? [])]) {
      if (turn.at <= waiter.after) continue;
      clearTimeout(waiter.timer);
      this.#drop(callId, waiter);
      waiter.resolve(this.turns(callId).filter((t) => t.role === 'assistant' && t.at > waiter.after));
    }
  }

  async #run(): Promise<void> {
    this.#controller = new AbortController();
    const res = await fetch(`${this.origin}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: this.#controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`agent /events → ${res.status}`);
    void this.#pump(res.body);
  }

  async #pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) this.#frame(frame);
      }
    } catch {
      // The lab shutting the stream, or the agent going away mid-run.
    }
  }

  #frame(frame: string): void {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (data === '') return;
    let row: { type?: string; call_id?: string; role?: string; text?: string };
    try {
      row = JSON.parse(data) as typeof row;
    } catch {
      return;
    }
    if (row.type !== 'turn' || !row.call_id || !row.text) return;
    this.#record(row.call_id, {
      role: row.role === 'user' ? 'user' : 'assistant',
      text: row.text,
      at: Date.now(),
    });
  }
}
