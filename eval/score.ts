/**
 * Scores one method's outputs against eval/public-cases.json.
 *
 *   tsx eval/score.ts eval/results/<method>.json
 *
 * Input: { [case_id]: Action[] } — the actions the method would submit (book /
 * register / cancel / reschedule / escalate / no_action), same field names as the
 * clinic API bodies. A case is EXACT when its action list equals one of the
 * `expected.acceptable` alternatives (order-insensitive, every field of the expected
 * action present and equal, extra fields on ours ignored — `notes` and free text are
 * never compared). FIELD score = fraction of expected fields matched against the best
 * alternative, with the action kind itself counting as one field. HTTP 200 is not
 * correctness; only the body is.
 */
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;
interface Case { id: string; problem_id: string; expected: { acceptable: { actions: Json[] }[] } }

const IGNORED = new Set(['notes', 'reason_text', 'free_text']);

const norm = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify(v);
};

/** One level of nesting (REGISTER's new_patient) is flattened to dotted paths. */
function fieldsOf(a: Json): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(a)) {
    if (IGNORED.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Json)) if (!IGNORED.has(k2)) out.push([`${k}.${k2}`, v2]);
    } else out.push([k, v]);
  }
  return out;
}

function at(a: Json, path: string): unknown {
  const [k, k2] = path.split('.');
  const v = a[k!];
  return k2 === undefined ? v : (v && typeof v === 'object' ? (v as Json)[k2] : undefined);
}

/** Fields matched between one expected action and one produced action. */
function actionScore(expected: Json, got: Json | undefined): { matched: number; total: number; misses: string[] } {
  const fields = fieldsOf(expected);
  const total = Math.max(fields.length, 1);
  if (!got) return { matched: 0, total, misses: fields.map(([k]) => k) };
  const misses: string[] = [];
  let matched = 0;
  for (const [k, v] of fields) {
    if (norm(at(got, k)) === norm(v)) matched++;
    else misses.push(`${k}: want ${norm(v) || '∅'} got ${norm(at(got, k)) || '∅'}`);
  }
  return { matched, total, misses };
}

/** Best assignment of produced actions to expected ones (small lists, brute force). */
function listScore(expected: Json[], got: Json[]): { matched: number; total: number; misses: string[]; exact: boolean } {
  if (expected.length === 0) {
    return { matched: got.length === 0 ? 1 : 0, total: 1, misses: got.length ? [`expected no action, got ${got.map((g) => norm(g.action)).join(',')}`] : [], exact: got.length === 0 };
  }
  let best = { matched: -1, total: 0, misses: [] as string[] };
  const used = new Array(got.length).fill(false);
  const walk = (i: number, acc: { matched: number; total: number; misses: string[] }): void => {
    if (i === expected.length) {
      if (acc.matched > best.matched) best = { ...acc, misses: [...acc.misses] };
      return;
    }
    const options = got.length ? got.map((g, j) => (used[j] ? undefined : [g, j] as const)).filter(Boolean) as (readonly [Json, number])[] : [];
    if (options.length === 0) {
      const s = actionScore(expected[i]!, undefined);
      walk(i + 1, { matched: acc.matched + s.matched, total: acc.total + s.total, misses: [...acc.misses, ...s.misses] });
      return;
    }
    for (const [g, j] of options) {
      used[j] = true;
      const s = actionScore(expected[i]!, g);
      walk(i + 1, { matched: acc.matched + s.matched, total: acc.total + s.total, misses: [...acc.misses, ...s.misses] });
      used[j] = false;
    }
  };
  walk(0, { matched: 0, total: 0, misses: [] });
  const extra = got.length - expected.length;
  const exact = best.matched === best.total && extra <= 0;
  if (extra > 0) best.misses.push(`${extra} extra action(s)`);
  return { ...best, exact };
}

export function scoreCase(c: Case, got: Json[] | undefined): { exact: boolean; field: number; misses: string[] } {
  const produced = got ?? [];
  let best: ReturnType<typeof listScore> | undefined;
  for (const alt of c.expected.acceptable) {
    const s = listScore(alt.actions, produced);
    if (!best || s.exact || s.matched / s.total > best.matched / best.total) best = s;
    if (s.exact) break;
  }
  return { exact: best!.exact, field: best!.matched / best!.total, misses: best!.misses };
}

if (process.argv[1]?.endsWith('score.ts')) {
  const cases = (JSON.parse(readFileSync(new URL('./public-cases.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;
  const file = process.argv[2];
  if (!file) { console.error('usage: tsx eval/score.ts eval/results/<method>.json'); process.exit(2); }
  const results = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Json[]>;
  let exact = 0; let field = 0;
  const byFamily = new Map<string, { n: number; exact: number; field: number }>();
  const failures: string[] = [];
  for (const c of cases) {
    const s = scoreCase(c, results[c.id]);
    exact += s.exact ? 1 : 0; field += s.field;
    const f = byFamily.get(c.problem_id) ?? { n: 0, exact: 0, field: 0 };
    f.n++; f.exact += s.exact ? 1 : 0; f.field += s.field; byFamily.set(c.problem_id, f);
    if (!s.exact) failures.push(`${c.id} [${c.problem_id}] ${results[c.id] ? '' : '(no output) '}${s.misses.slice(0, 4).join(' | ')}`);
  }
  console.log(`${file}\n  exact ${exact}/${cases.length} (${(100 * exact / cases.length).toFixed(1)}%)   field ${(100 * field / cases.length).toFixed(1)}%`);
  for (const [fam, f] of [...byFamily].sort()) console.log(`  ${fam.padEnd(18)} exact ${f.exact}/${f.n}  field ${(100 * f.field / f.n).toFixed(0)}%`);
  console.log('\nfailures:'); for (const line of failures) console.log('  ' + line);
}
