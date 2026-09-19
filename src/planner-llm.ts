import { llm, type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { JsonPlanner } from './json-planner.js';
import { clog } from './log.js';

export class PlannerLLM extends llm.LLM {
  readonly #planner: JsonPlanner;
  readonly #model: string;

  constructor(planner: JsonPlanner, model = '@cf/nvidia/nemotron-3-120b-a12b') {
    super();
    this.#planner = planner;
    this.#model = model;
  }

  label(): string {
    return 'json-planner';
  }

  get model(): string {
    return this.#model;
  }

  get provider(): string {
    return 'cloudflare';
  }

  chat({ chatCtx, connOptions }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
  }): llm.LLMStream {
    return new PlannerStream(this, this.#planner, { chatCtx, connOptions });
  }
}

class PlannerStream extends llm.LLMStream {
  readonly #planner: JsonPlanner;

  constructor(owner: PlannerLLM, planner: JsonPlanner, opts: {
    chatCtx: llm.ChatContext;
    connOptions?: APIConnectOptions;
  }) {
    super(owner, {
      chatCtx: opts.chatCtx,
      toolCtx: undefined,
      connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
    this.#planner = planner;
  }

  async run(): Promise<void> {
    const transcript = this.chatCtx.items
      .filter((item): item is llm.ChatMessage => item.type === 'message')
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .map((item) => {
        const text = item.textContent?.trim();
        return text ? {
          role: item.role === 'user' ? 'caller' as const : 'receptionist' as const,
          text,
        } : undefined;
      })
      .filter((item): item is { role: 'caller' | 'receptionist'; text: string } => Boolean(item));
    const before = this.#planner.llmCalls;
    const say = await this.#planner.turn(transcript);
    clog.info(`[planner] turn llm_calls=${this.#planner.llmCalls - before} rounds=${this.#planner.rounds} ${this.#planner.lastTurnMs} ms`);
    if (this.closed) return;
    this.output.put({
      id: randomUUID(),
      delta: { role: 'assistant', content: say },
    });
    this.close();
  }
}
