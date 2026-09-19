/**
 * The local suite: four to five cases for each of the eighteen problems, generated
 * against this machine's world so every expectation is exact and gradeable offline.
 *
 * Built once per boot, like the world itself — a case that names "the earliest
 * orthopaedics slot" means the one that was earliest when the mock started.
 */
import type { World } from '../world.js';
import { bookingCases } from './cases-booking.js';
import { conversationCases } from './cases-conversation.js';
import { recordCases } from './cases-records.js';
import { type Case, PROBLEMS, type Problem } from './types.js';

export * from './types.js';

export interface Suite {
  problems: Problem[];
  cases: Case[];
  byId: Map<string, Case>;
  ofProblem: (problemId: string) => Case[];
}

export function buildSuite(world: World): Suite {
  return suiteOf([...bookingCases(world), ...recordCases(world), ...conversationCases(world)]);
}

/** The same shape over cases from anywhere — the real clinic's, in mirror mode. */
export function suiteOf(all: Case[]): Suite {
  const cases = [...all].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
  return {
    problems: PROBLEMS,
    cases,
    byId: new Map(cases.map((c) => [c.id, c])),
    ofProblem: (problemId) => cases.filter((c) => c.problem_id === problemId),
  };
}

function order(c: Case): number {
  return PROBLEMS.findIndex((p) => p.id === c.problem_id);
}
