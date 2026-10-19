// GGPO-style synctest: journal a scripted call stream against a live
// moveSim, replay it into a fresh sim, and the hash markers must hold —
// the forensic path works end to end. Also the negative control: a
// tampered event must trip a marker, not pass silently.
import { test, expect } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { SimJournal, replayJournal } from '../src/simJournal.ts';
import { hmParseBin, type Heightfield } from '../../shared/heightfield.ts';

const flat: Heightfield = hmParseBin((() => {
  const b = new Uint8Array(8 + 4);
  new DataView(b.buffer).setUint32(0, 2, true);
  new DataView(b.buffer).setUint32(4, 2, true);
  b.fill(60, 8);
  return b;
})());

function scripted(sim: RoomMoveSim): void {
  // A realistic call mix: track, queued + immediate inputs, impulses,
  // a resync discontinuity, an energy drain — the full journal surface.
  sim.track('p1', { x: 0, y: 60, z: 0 }, 0);
  sim.track('p2', { x: 20, y: 60, z: 10 }, 1.5);
  for (let t = 0; t < 130; t += 1) {
    if (t === 3) {sim.queueInput('p1', { forward: 1, skiHeld: true }, 0, 1);}
    if (t === 10) {sim.setInput('p1', { jetHeld: true }, 0, 2);}
    if (t === 30) {sim.applyImpulse('p2', { x: 4, y: 8, z: -2 });}
    if (t === 60) {sim.drainEnergy('p1', 20);}
    if (t === 80) {sim.resync('p2', { x: 40, y: 80, z: 40 }, 2.2, true);}
    if (t === 90) {sim.faceYaw('p1', 0.7);}
    if (t === 100) {sim.queueInput('p2', { forward: -1, skiHeld: true }, 0, 1);}
    sim.tick(0.05);
  }
}

test('journal replay is deterministic — hash markers hold through the whole call stream', () => {
  const live = new RoomMoveSim(flat);
  live.journal = new SimJournal();
  scripted(live);
  expect(live.journal.events.some((e) => e.kind === 'hash')).toBe(true);

  const replay = new RoomMoveSim(flat);
  const split = replayJournal(live.journal.events, replay, () => replay.journalHash());
  expect(split).toBe(-1);
});

test('a tampered event splits the hash at its marker — the check actually fires', () => {
  const live = new RoomMoveSim(flat);
  live.journal = new SimJournal();
  scripted(live);
  // Forge one input edge's forward axis — replay must diverge.
  const ev = live.journal.events.find((e) => e.kind === 'input')!;
  if (ev.kind === 'input') {ev.input.forward = -1;}
  const replay = new RoomMoveSim(flat);
  const split = replayJournal(live.journal.events, replay, () => replay.journalHash());
  expect(split).toBeGreaterThan(0);
});
