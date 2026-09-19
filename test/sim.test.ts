/**
 * The shared clinic: one diary, many calls. Runs against the bundled catalogue, an
 * empty patient list and a fixed clock, with SQLite on a temp file so persistence is
 * the real thing and not a mock of one.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAction } from '../mock/submit/schemas.js';
import { Clinic, type SimEventType } from '../sim/clinic.js';
import { openDb } from '../sim/db.js';
import type { ClinicBody } from '../sim/prosper.js';
import { createSimServer } from '../sim/server.js';
import { writeSnapshot } from '../sim/snapshot.js';
import catalogue from '../mock/world/catalogue.json' with { type: 'json' };

const raw = catalogue as unknown as Omit<ClinicBody, 'patient_count' | 'calendar' | 'plans'> & {
  calendar: Omit<ClinicBody['calendar'], 'appointment_count'>;
  plans: Omit<ClinicBody['plans'][number], 'holders'>[];
};
const body: ClinicBody = {
  ...raw,
  patient_count: 0,
  calendar: { ...raw.calendar, appointment_count: 0 },
  plans: raw.plans.map((p) => ({ ...p, holders: 0 })),
};

// Monday 2026-09-14, 08:00 in Madrid — inside the calendar, before the day's first slot.
const NOW = Date.parse('2026-09-14T08:00:00+02:00');
// PR01 (general practice, centro) works Monday 09:00–14:00. `review` is one 15-minute cell.
const SLOT = '2026-09-14T09:00:00+02:00';
const NEXT = '2026-09-14T09:15:00+02:00';
const PR = 'PR01';
const AT = { provider_id: PR, location_id: 'centro', appointment_type_id: 'review' };
// PR01 is busy 10:00–10:15 in the snapshot: one cell nobody can have.
const BUSY = '2026-09-14T10:00:00+02:00';

const dir = mkdtempSync(join(tmpdir(), 'sim-test-'));
const dbPath = join(dir, 'clinic.db');
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (err: unknown) => {
        failed++;
        console.log(`  FAIL ${name}\n       ${String(err instanceof Error ? err.message : err)}`);
      },
    );
}

function open(): Clinic {
  const db = openDb(dbPath);
  if (!Clinic.hasSnapshot(db)) writeSnapshot(db, 'test', body, null, [{ provider_id: PR, date: '2026-09-14', minute: 600 }], NOW);
  return new Clinic({ db, holdTtlMs: 1_000 });
}

function starts(clinic: Clinic, callId?: string): string[] {
  return clinic
    .availability({ date_from: '2026-09-14', date_to: '2026-09-14', provider_id: PR, insurer: [] }, NOW, callId ?? null)
    .slots.map((s) => s.start_time);
}

function book(clinic: Clinic, callId: string, patientId: string, slot: string, now = NOW) {
  const data = { call_id: callId, patient_id: patientId, ...AT, slot, policy_id: 'dkv' };
  return clinic.submit('book', data, toAction('book', data), now);
}

async function main(): Promise<void> {
  let clinic = open();

  await check('snapshot occupancy is busy for everyone', () => {
    assert.ok(starts(clinic).includes(SLOT));
    assert.ok(!starts(clinic).includes(BUSY));
  });

  await check('a hold hides the slot from other calls, not from its owner', () => {
    const held = clinic.hold({ call_id: 'A', ...AT, start_time: SLOT }, NOW);
    assert.ok(held.ok, JSON.stringify(held));
    assert.ok(!starts(clinic, 'B').includes(SLOT), 'B still sees it');
    assert.ok(!starts(clinic).includes(SLOT), 'anonymous still sees it');
    assert.ok(starts(clinic, 'A').includes(SLOT), 'A lost sight of its own hold');
  });

  await check('a second call cannot hold the same slot', () => {
    const clash = clinic.hold({ call_id: 'B', ...AT, start_time: SLOT }, NOW);
    assert.ok(!clash.ok && clash.status === 409, JSON.stringify(clash));
    assert.match(clash.ok ? '' : clash.detail, /call A/);
  });

  await check('booking over another call\'s hold is refused; the holder books', () => {
    const b = book(clinic, 'B', 'P00001', SLOT);
    assert.ok(!b.ok && b.status === 409);
    const a = book(clinic, 'A', 'P00002', SLOT);
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(clinic.holds().length, 0, 'the booking should have consumed the hold');
    assert.ok(!starts(clinic, 'A').includes(SLOT), 'booked slot still offered');
  });

  await check('the same call cannot book the same slot twice', () => {
    const again = book(clinic, 'A', 'P00002', SLOT);
    assert.ok(!again.ok && again.status === 409);
  });

  await check('a hold expires on its own', () => {
    const held = clinic.hold({ call_id: 'C', ...AT, start_time: NEXT }, NOW);
    assert.ok(held.ok);
    assert.ok(!starts(clinic, 'D').includes(NEXT));
    clinic.expireHolds(NOW + 1_500);
    assert.equal(clinic.holds().length, 0);
    assert.ok(starts(clinic, 'D').includes(NEXT));
  });

  await check('reschedule moves the cells; the old time is free again', () => {
    const appt = clinic.appointmentsOn('2026-09-14', PR).find((a) => a.status === 'active');
    assert.ok(appt);
    const data = { call_id: 'E', patient_id: appt.patient_id, appointment_id: appt.appointment_id, ...AT, slot: NEXT, policy_id: 'dkv' };
    const moved = clinic.submit('reschedule', data, toAction('reschedule', data), NOW);
    assert.ok(moved.ok, JSON.stringify(moved));
    // The anonymous search prices a 30-minute first visit, so 09:00 needs 09:15 too; ask the cells.
    assert.ok(clinic.isFree(PR, '2026-09-14', 540, 1, null, NOW), 'old cell not freed');
    assert.ok(!clinic.isFree(PR, '2026-09-14', 555, 1, null, NOW), 'new cell not taken');
    assert.ok(!starts(clinic).includes(NEXT));
    // Onto the snapshot's busy cell: refused, and nothing moved.
    const onto = { ...data, call_id: 'F', slot: BUSY };
    const refused = clinic.submit('reschedule', onto, toAction('reschedule', onto), NOW);
    assert.ok(!refused.ok && refused.status === 409);
    assert.ok(!starts(clinic).includes(NEXT));
  });

  await check('cancel frees the cells and shows in the patient\'s diary', () => {
    const appt = clinic.appointmentsOn('2026-09-14', PR).find((a) => a.status === 'active');
    assert.ok(appt);
    const data = { call_id: 'G', patient_id: appt.patient_id, appointment_id: appt.appointment_id };
    const gone = clinic.submit('cancel', data, toAction('cancel', data), NOW);
    assert.ok(gone.ok, JSON.stringify(gone));
    assert.ok(starts(clinic).includes(NEXT));
    assert.equal(clinic.appointmentsFor(appt.patient_id, 'upcoming', NOW).length, 0);
    const twice = clinic.submit('cancel', data, toAction('cancel', data), NOW);
    assert.ok(!twice.ok);
  });

  await check('register adds a patient the directory can find', async () => {
    const data = {
      call_id: 'H', given_name: 'Ana', first_surname: 'Prueba', second_surname: 'Sim', national_id: '12345678Z',
      date_of_birth: '1990-01-01', phone: '600000000', email: 'ana@example.com', insurer: 'dkv',
    };
    const reg = clinic.submit('register', data, toAction('register', data), NOW);
    assert.ok(reg.ok, JSON.stringify(reg));
    const found = await clinic.directory({ national_id: '12345678Z' });
    assert.equal(found?.length, 1);
    assert.equal(found?.[0]?.given_name, 'Ana');
    const dup = clinic.submit('register', { ...data, call_id: 'I' }, toAction('register', data), NOW);
    assert.ok(!dup.ok && dup.status === 409);
  });

  await check('the submission window closes 30 s after the call', () => {
    clinic.openCall('J', {}, NOW);
    clinic.closeCall('J', NOW);
    assert.ok(book(clinic, 'J', 'P00003', SLOT, NOW + 10_000).ok);
    const late = book(clinic, 'J', 'P00003', NEXT, NOW + 40_000);
    assert.ok(!late.ok && late.status === 410);
  });

  await check('everything survives a restart', () => {
    const before = clinic.state(NOW);
    clinic.db.close();
    clinic = open();
    const after = clinic.state(NOW);
    assert.deepEqual(after.appointments, before.appointments);
    assert.deepEqual(after.patients, before.patients);
    assert.ok(!starts(clinic).includes(SLOT), 'J\'s booking should still be on the diary');
    assert.equal(clinic.eventsSince(0, 1000).length, (before.events as number));
  });

  await check('events are ordered and replayable', () => {
    const all = clinic.eventsSince(0, 1000);
    assert.equal(all[0]?.type, 'snapshot');
    const types = all.map((e) => e.type);
    const expected: SimEventType[] = ['hold', 'hold_conflict', 'book_rejected', 'book', 'hold_released', 'hold_expired', 'reschedule', 'cancel', 'register'];
    for (const t of expected) {
      assert.ok(types.includes(t), `missing event ${t}`);
    }
    const tail = clinic.eventsSince(all[all.length - 3]!.id, 1000);
    assert.equal(tail.length, 2);
  });

  await check('reset restores the snapshot and keeps nothing local', () => {
    clinic.reset(NOW);
    assert.ok(starts(clinic).includes(SLOT));
    assert.ok(!starts(clinic).includes(BUSY), 'snapshot occupancy must come back');
    assert.deepEqual(clinic.state(NOW).appointments, { prosper: 0, local: 0, cancelled: 0 });
    assert.equal(clinic.holds().length, 0);
  });

  await check('HTTP: state, hold via route, and SSE replay', async () => {
    const server = createSimServer({ clinic, live: null });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const state = (await (await fetch(`${base}/__sim`)).json()) as { busy_cells: number; holds: number };
      assert.equal(state.busy_cells, 1);

      const noKey = await fetch(`${base}/api/v1/clinic`);
      assert.equal(noKey.status, 403);
      const clinicRes = (await (await fetch(`${base}/api/v1/clinic`, { headers: { 'X-Api-Key': 'x' } })).json()) as { clinic_name: string };
      assert.equal(clinicRes.clinic_name, body.clinic_name);

      const res = await fetch(`${base}/__sim/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: 'K', ...AT, start_time: SLOT }),
      });
      assert.equal(res.status, 200);
      const hold = (await res.json()) as { hold_id: string };

      const ac = new AbortController();
      const stream = await fetch(`${base}/__sim/events?since=0`, { signal: ac.signal });
      const reader = stream.body!.getReader();
      let text = '';
      while (!text.includes('event: hold\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      ac.abort();
      assert.match(text, /^event: reset$/m);
      assert.match(text, /^event: hold$/m);
      assert.match(text, new RegExp(hold.hold_id));

      const del = await fetch(`${base}/__sim/holds/${hold.hold_id}?call_id=K`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal(clinic.holds().length, 0);
    } finally {
      server.close();
    }
  });

  clinic.db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? '\nsim: all passed' : `\nsim: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
