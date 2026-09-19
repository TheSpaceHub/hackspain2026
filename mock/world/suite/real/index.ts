/**
 * The real-clinic suite: the eighteen written problems, plus however many
 * randomly generated asks were requested, all built from one seed.
 */
import { suiteOf, type Suite } from '../index.js';
import { realCases } from './cases.js';
import type { RealWorld } from './context.js';
import { randomCases } from './random.js';

export interface Generation {
  source: 'real' | 'generated';
  /** Only the random cases use it; the written ones are what the clinic says today. */
  seed: number;
  random: number;
  /** Random asks restricted to ones the clinic can book. */
  viable: boolean;
}

export async function buildRealSuite(w: RealWorld, gen: { seed: number; random: number; viable: boolean }): Promise<Suite> {
  const written = await realCases(w);
  const random = gen.random > 0 ? await randomCases(w, gen.seed, gen.random, gen.viable) : [];
  return suiteOf([...written, ...random]);
}
