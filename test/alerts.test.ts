import { type AlertInput, detectAlerts } from '../src/store/alerts.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

const base: AlertInput = {
  fromNumber: '+34612345000',
  ended: true,
  endedBy: 'stop',
  callMs: 60_000,
  closeToSubmittedMs: 5_000,
  usedFloor: false,
  submissions: [{ action: 'no_action', status: 200 }],
  turns: [],
};
const ids = (over: Partial<AlertInput>): string[] => detectAlerts({ ...base, ...over }).map((a) => a.id);
const agent = (seq: number, text: string) => ({ seq, role: 'assistant', text });
const caller = (seq: number, text: string) => ({ seq, role: 'user', text });

check('a clean call has no alerts', ids({}), []);

// Problem 14: the agent's turns are checked for another patient's id and phone.
check('a phone read out a digit at a time leaks', ids({ turns: [agent(3, 'It is six one one, two two two, three three three.')] }), ['leak']);
check('an id written in one piece leaks', ids({ turns: [agent(4, 'The id on file is 87654321X.')] }), ['leak']);
check('a NIE spelled out leaks', ids({ turns: [agent(6, 'That is X 1 2 3 4 5 6 7 L')] }), ['leak']);
check('the leak points at its turn', detectAlerts({ ...base, turns: [agent(9, 'Call 611 222 333')] })[0]?.seqs, [9]);
check("the caller's own line read back is not a leak", ids({ turns: [agent(5, 'I have you on 612 345 000.')] }), []);
check('an id the caller gave, read back, is not a leak',
  ids({ turns: [caller(1, 'My DNI is one two three four five six seven eight Z'), agent(2, 'Thanks, 12345678Z.')] }), []);
check('dates and times are not phones', ids({ turns: [agent(7, 'at nine thirty on the 21st, 2026')] }), []);

check('nothing submitted is no record', ids({ submissions: [] }), ['no_record']);
check('a live call without a record is not flagged yet', ids({ ended: false, submissions: [] }), []);
check('a 410 is refused and leaves no record', ids({ submissions: [{ action: 'book', status: 410 }] }), ['no_record', 'rejected']);
check('a 409 duplicate still counts as the record', ids({ submissions: [{ action: 'book', status: 409 }] }), []);
check('the wall clock cut the call', ids({ endedBy: 'wall_clock' }), ['cut_off']);

check('no_action beside another action conflicts',
  ids({ submissions: [{ action: 'book', status: 200 }, { action: 'no_action', status: 200 }] }), ['conflicting']);
check('the same action accepted twice conflicts',
  ids({ submissions: [{ action: 'book', status: 200 }, { action: 'book', status: 200 }] }), ['conflicting']);
check('register then book is a legitimate pair',
  ids({ submissions: [{ action: 'register', status: 200 }, { action: 'book', status: 200 }] }), []);
check('over 20 s to submit is late', ids({ closeToSubmittedMs: 24_000 }), ['late_submit']);
check('the floor answering is flagged', ids({ usedFloor: true }), ['floor']);

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
