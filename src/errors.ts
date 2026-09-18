/** Node's fetch hides the real reason (DNS, refused, TLS) behind "fetch failed". */
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
