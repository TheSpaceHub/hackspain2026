import { callContext, clog } from '../src/log.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${String(expected)}\n        actual   ${String(actual)}`}`);
}

const originalWarn = console.warn;
const lines: string[] = [];
console.warn = (message: string): void => {
  lines.push(message);
};
callContext.run('abcdef12-rest', () => clog.warn('inside'));
clog.warn('outside');
console.warn = originalWarn;

check('call logs carry the short call id', lines[0], '[call abcdef12] inside');
check('logs outside a call have no prefix', lines[1], 'outside');

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
