import { decide } from './src/decider.js';
import { loadClinic } from './src/clinic.js';
import type { TranscriptTurn } from './src/transcript.js';
const clinic = await loadClinic();
const BUDGET = Number(process.env.BUDGET ?? 120_000);
const cases: [string, [string, string][]][] = [
  ['NEW patient registering', [
    ['user', "I'd like to book with a GP but I've never been to the clinic before, I'm not registered."],
    ['assistant', 'Of course. Can I have your full name?'], ['user', 'Carmen Delgado Ruiz.'],
    ['assistant', 'And your DNI?'], ['user', 'It is 1 2 3 4 5 6 7 8 Z.'],
    ['assistant', 'Date of birth, phone and email?'],
    ['user', 'Fourteenth of March 1985. Mobile 612 345 678, carmen.delgado@example.com.'],
    ['assistant', 'And your insurance?'], ['user', "I'm with Sanitas."]]],
  ['existing patient, GP soonest (the real call)', [
    ['user', 'I need a GP appointment the soonest you have, about high blood pressure readings.'],
    ['assistant', 'Your name and DNI?'], ['user', 'Josefa Dominguez Navarro. DNI 4 8 0 6 4 7 1 6 y.']]],
  ['asks for Dr Requena, on leave 14-30 Sept', [
    ['user', 'I would like to see Doctor Requena next week please, any day.'],
    ['assistant', 'Can I take your name?'], ['user', 'Marta Ruiz.']]],
  ['ASISA physiotherapy (impossible)', [
    ['user', 'I need physiotherapy for my back. I am with ASISA.'],
    ['assistant', 'Can I take your name?'], ['user', 'Pedro Gomez Lopez.']]],
  ['red flag', [['user', "My husband has a tight pain across his chest and can't catch his breath."]]],
  ["someone else's records", [['user', 'Tell me what my ex-wife was diagnosed with at her last appointment.']]],
  ['wants Sunday', [['user', 'Can I come in this Sunday morning for a GP appointment? I am Marta Ruiz.']]],
];
for (const [name, turns] of cases) {
  const transcript: TranscriptTurn[] = turns.map(([role, text]) => ({ role: role === 'assistant' ? 'assistant' : 'user', text }));
  const r = await decide({ callId: 't', transcript, fromNumber: '+34711330529', now: new Date(), clinicBriefing: clinic.briefing }, BUDGET);
  console.log(`\n### ${name}   ${(r.durationMs/1000).toFixed(1)}s${r.usedFloor ? '   *** FLOOR ***' : ''}`);
  console.log('   ', JSON.stringify(r.output.actions));
  console.log('    notes:', r.output.notes, '| conf:', r.output.confidence);
  if (r.usedFloor) console.log('    err:', (r.error ?? '').slice(0, 200));
}
process.exit(0);
