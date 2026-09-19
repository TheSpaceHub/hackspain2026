# Decision-method bake-off

Five independent implementations of the receptionist's *decision making*, all run against the
same 73 frozen public cases (`eval/public-cases.json`) with the same frozen caller simulator
(`eval/caller.ts`) and scored by the same scorer (`eval/score.ts`). Only the receptionist side
differs.

## Contract every method must satisfy

- Lives entirely in `eval/methods/<method>/` (own files only; do **not** edit anything under
  `src/`, `test/`, or another method's folder — you may import from `src/` freely).
- Entry point: `npx tsx eval/methods/<method>/run.ts [--only <case_id>] [--limit N] [--concurrency N]`
  - loads `eval/public-cases.json`
  - for each case: `const caller = new SimCaller(c)`; `let said = await caller.reply(undefined)`;
    loop: receptionist produces its next line, `said = await caller.reply(line)`, until
    `caller.hungUp` or `said === undefined`
  - the receptionist may call the clinic **read-only**: `ClinicApi.findPatient`,
    `getPatientAppointments`, `findAvailability`, `getCatalogue` (`src/clinic-api.ts`, base URL
    and key from `config.prosper` in `src/config.ts`, which reads `.env`). **Never** call the
    book/register/cancel/reschedule endpoints (`src/submit.ts`) — the decision is the output,
    not a submission.
  - "now" is the case's `reference_time` (`2026-09-18T09:00:00+02:00`), **not** the wall clock.
    Every date resolution, age/leave check and "earliest" comparison uses that.
  - writes `eval/results/<method>.json`: `{ [case_id]: Action[] }` in the **public-case shape**
    (see below), plus `eval/results/<method>.transcripts.jsonl` (one line per case:
    `{ id, transcript, actions, notes }`) for failure analysis.
- Then run `npx tsx eval/score.ts eval/results/<method>.json` and report the numbers.

## Output action shape (what the scorer compares)

Same as `expected.acceptable[i].actions` in the cases file:

```
{ action: 'BOOK', patient_id, provider_id, location_id, appointment_type_id, slot, policy_id }
{ action: 'RESCHEDULE', appointment_id, provider_id, location_id, slot, policy_id }
{ action: 'CANCEL', appointment_id }
{ action: 'REGISTER', new_patient: { given_name, first_surname, second_surname, national_id, date_of_birth, phone, email, insurer } }
{ action: 'ESCALATE', reason: 'medical_emergency' }
{ action: 'NO_ACTION', reason: <one of src/schema.ts REASONS> }
```

`slot` is the ISO start time with `+02:00` offset exactly as `findAvailability` returns it.
`policy_id` is the insurer id from the patient's record (or the second policy when the caller
says to use it). Location ids are `centro | norte | sur`. An empty list `[]` counts as
NO_ACTION-with-nothing and is wrong for every case; when nothing can be done emit NO_ACTION with
the right reason.

## Domain facts (authoritative, from the clinic catalogue and rules)

- Patients are identified by phone first (`findPatient({ phone })`), else by DNI/NIE, else by name+DOB.
  The caller is not always the patient ("for my mother", "the person I care for", carers, parents).
- Appointment type: `first_visit` if the patient has never visited, else `review` — for GP. Specialties
  have their own type ids (e.g. `dermatology_review`, `orthopaedic_review`, see `appointment_types` in
  the catalogue with `specialty_id` and `is_first_visit`).
- Rules in the catalogue: provider networks per insurer, specialty coverage per insurer, site coverage
  per insurer, referral requirements per specialty, age limits (paediatrics), provider leave, site
  opening hours. `src/patient-brief.ts` and `src/guards.ts` already encode most of them.
- Red flags (chest pain, stroke signs, heavy bleeding, breathing trouble…) → ESCALATE medical_emergency,
  no booking.
- Never invent a provider, site, time, insurer or department; only what the catalogue/diary returned.

## The five methods

1. `rules` — pure deterministic state machine. No LLM on the receptionist side at all:
   regex/fuzzy extraction (reuse `src/extract.ts` helpers, `src/fuzzy.ts`, `src/when.ts`,
   `src/normalize.ts`), scripted dialogue, `bookFromState`-style invariants.
2. `llm-json` — a single LLM (Cloudflare `config.cloudflare.deciderModel` or dialogue model) that,
   given the whole transcript so far plus the authoritative record/catalogue/availability as
   text, returns the next receptionist line **and** the current draft action as one JSON object.
   Tools are called by the harness code when the JSON asks for them.
3. `llm-veto` — an LLM proposes (as in 2) but a deterministic layer (`src/guards.ts`,
   `src/patient-brief.ts` eligibility, slot-must-have-been-quoted, appointment-must-be-selected)
   can veto or downgrade each action to NO_ACTION with the rule's reason; vetoes are fed back to the
   model as a correction.
4. `vote` — two different models (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and
   `@cf/nvidia/nemotron-3-120b-a12b`) each produce a decision from the same evidence; agreement
   wins, disagreement triggers a third tie-break call with both answers shown, and if still
   inconsistent the conservative action (NO_ACTION with the better-supported reason) is used.
5. `chain` — a structured per-rule chain: separate small steps (who is the patient → which
   intent → which specialty/provider/site → eligibility rules one by one → slot selection → final
   action), each step either deterministic or a tiny LLM classification with a closed set of
   answers, with the state carried between steps.

## Rules of the road

- Work only inside your `eval/methods/<method>/` folder plus your two result files.
- Do not run `git checkout`/`git stash`/branch switches; do not restart any server on the machine
  (ports 7860/7861/8788/5173/5175 belong to running agents). Commit nothing; the lead commits.
- Cloudflare model calls: see `src/decider.ts` for the request shape (`config.cloudflare.baseURL`
  + `/chat/completions`, bearer `config.cloudflare.apiToken`). Keep concurrency ≤ 3 per method to
  avoid rate limits; the whole run should finish in well under an hour.
- Node is at `$HOME/.nvm/versions/node/*/bin`; run from the repo root with `npx tsx`.
