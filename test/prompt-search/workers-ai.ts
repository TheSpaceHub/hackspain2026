/** Plain chat completions against Workers AI, for the caller persona and the reflector. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  json?: boolean;
}

function creds(): { accountId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  return { accountId, token };
}

export async function complete(messages: ChatMessage[], opts: CompleteOptions): Promise<string> {
  const { accountId, token } = creds();
  const baseURL =
    process.env.CLOUDFLARE_AI_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 400,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      lastError = `${opts.model} ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
        continue;
      }
      throw new Error(lastError);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim() !== '') return content;
    lastError = `${opts.model}: empty content`;
  }
  throw new Error(lastError);
}
