/**
 * One chat call, against whichever provider this machine has keys for. The lab
 * only ever asks for a line of speech or a short judgement, so there is no
 * streaming, no tools, and no reason to pull in a client.
 */
const CLOUDFLARE_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN));
}

export function llmName(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.TESTLAB_MODEL ?? 'claude-haiku-4-5';
  return process.env.TESTLAB_MODEL ?? CLOUDFLARE_DEFAULT;
}

export async function chat(messages: Message[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  const maxTokens = opts.maxTokens ?? 200;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  return process.env.ANTHROPIC_API_KEY ? anthropic(messages, maxTokens, signal) : cloudflare(messages, maxTokens, signal);
}

async function anthropic(messages: Message[], maxTokens: number, signal: AbortSignal): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: llmName(),
      max_tokens: maxTokens,
      system,
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (body.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('').trim();
}

async function cloudflare(messages: Message[], maxTokens: number, signal: AbortSignal): Promise<string> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const base = process.env.CLOUDFLARE_AI_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    },
    body: JSON.stringify({ model: llmName(), max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string | number } }[] };
  return String(body.choices?.[0]?.message?.content ?? '').trim();
}
