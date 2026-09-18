/**
 * Node's fetch throws a bare `TypeError: fetch failed` and hides the real reason
 * (DNS, refused connection, TLS) in `cause`. A call log that only says "fetch
 * failed" cannot be debugged after the fact, so unwrap the chain.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(`${current.name}: ${current.message}${code ? ` (${code})` : ''}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(' <- ') : String(err);
}
