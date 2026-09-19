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
}

export async function buildRealSuite(w: RealWorld, gen: { seed: number; random: number }): Promise<Suite> {
  const written = await realCases(w);
  const random = gen.random > 0 ? await randomCases(w, gen.seed, gen.random) : [];
  return suiteOf([...written, ...random]);
}
