/**
 * Callers and speech recognition both get names slightly wrong: "gynecology" for
 * `gynaecology`, "Doctor Villar" for Tomás Vilar, "sonita" for sanitas. Exact matching
 * turns each of those into a 404, a denial that a real doctor exists, or a 422.
 *
 * Everything here is deliberately conservative. A confident wrong match bills the wrong
 * plan or books the wrong doctor; an ambiguous one is handed back so the agent can ask.
 */

/** Lower-case, accent-stripped, underscores said as spaces: "Sáenz" is "saenz". */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/**
 * Damerau–Levenshtein: insert, delete, substitute, and transpose two adjacent
 * characters — the four ways a name comes back wrong.
 */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rows are enough: the transposition only ever looks two rows back.
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = [];

  for (let i = 1; i <= a.length; i++) {
    current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(current[j - 1]! + 1, oneBack[j]! + 1, oneBack[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2]! + 1);
      }
      current[j] = best;
    }
    twoBack = oneBack;
    oneBack = current;
  }
  return oneBack[b.length]!;
}

/**
 * How far off a match may be, by length of what was said. One edit is always allowed —
 * that is the whole of "gynecology" versus "gynaecology" — and longer phrases get a
 * little more room without letting "Vilar" reach "Molina".
 */
export function tolerance(needle: string): number {
  return Math.max(1, Math.floor(needle.length / 5), needle.length >= 6 ? 2 : 1);
}

export interface Candidate<T> {
  item: T;
  /** Every string this item answers to: its id, its name, a surname on its own. */
  aliases: string[];
}

export interface Match<T> {
  item: T;
  distance: number;
}

/**
 * The candidates that best match what was said, within tolerance.
 *
 * An exact fold match wins outright. Otherwise everything within one edit of the best
 * score comes back together: two names that close cannot be told apart by spelling, so
 * the caller has to be asked rather than guessed at. An empty result means nothing was
 * close enough — and nothing close enough must never be sent to the clinic's API.
 */
export function closest<T>(candidates: Candidate<T>[], spoken: string): Match<T>[] {
  const needle = fold(spoken);
  if (needle === '') return [];

  const scored: Match<T>[] = [];
  for (const candidate of candidates) {
    let best = Infinity;
    for (const alias of candidate.aliases) {
      const folded = fold(alias);
      if (folded === '') continue;
      // "physio" is not a misspelling of physiotherapy, it is the start of it. Short
      // needles are excluded: "der" would reach dermatology and little else usefully.
      const prefix = needle.length >= 4 && folded.startsWith(needle);
      best = Math.min(best, folded === needle || prefix ? 0 : distance(needle, folded));
      if (best === 0) break;
    }
    if (best !== Infinity) scored.push({ item: candidate.item, distance: best });
  }

  const exact = scored.filter((m) => m.distance === 0);
  if (exact.length > 0) return exact;

  const limit = tolerance(needle);
  const within = scored.filter((m) => m.distance <= limit).sort((a, b) => a.distance - b.distance);
  if (within.length === 0) return [];

  const bestScore = within[0]!.distance;
  return within.filter((m) => m.distance <= bestScore + 1);
}

/** The single unambiguous match, or nothing. Use when there is no one to ask. */
export function only<T>(candidates: Candidate<T>[], spoken: string): T | undefined {
  const matches = closest(candidates, spoken);
  return matches.length === 1 ? matches[0]!.item : undefined;
}
