/**
 * Seeded randomness. The invented world is generated once per boot from a fixed
 * seed, so every teammate's mock holds the same patients with the same ids — a
 * transcript from one machine means the same thing on another.
 */

export interface Random {
  /** [0, 1) */
  next(): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  chance(p: number): boolean;
  shuffle<T>(items: T[]): T[];
  digits(n: number): string;
}

/** mulberry32: small, fast, and good enough for fixtures. */
export function createRandom(seed: number): Random {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r: Random = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let x = next() * total;
      for (const [item, w] of items) {
        if ((x -= w) < 0) return item;
      }
      return items[items.length - 1]![0];
    },
    chance: (p) => next() < p,
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
    digits: (n) => Array.from({ length: n }, () => Math.floor(next() * 10)).join(''),
  };
  return r;
}
