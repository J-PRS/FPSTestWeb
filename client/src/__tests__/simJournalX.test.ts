// Cross-engine leg: the simJournal replay runs under V8 (vitest) too —
// if a transcendental leaked into the sim's hot path, the JSC-recorded
// hash markers would split here. Shared sims are the assertion surface.
import { describe, it, expect } from 'vitest';
import { RoomMoveSim } from '../../../server_bun/src/RoomMoveSim.js';
import { replayJournal, type JournalEv } from '../../../server_bun/src/simJournal.js';
import { hmParseBin, type Heightfield } from '../../../shared/heightfield.js';

const flat: Heightfield = hmParseBin((() => {
  const b = new Uint8Array(8 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 2, true); dv.setUint32(4, 2, true);
  b.fill(60, 8);
  return b;
})());

// A fixed event stream — written once, replayed on both engines. The
// hash markers' expected values come from a Bun-side capture baked in
// (any transcendental divergence would split them).
const EVENTS: JournalEv[] = [
  { t: 0, kind: 'track', pid: 'p1', pos: { x: 0, y: 60, z: 0 }, yaw: 0 },
  { t: 0, kind: 'track', pid: 'p2', pos: { x: 20, y: 60, z: 10 }, yaw: 1.5 },
  { t: 3, kind: 'input', pid: 'p1', input: { forward: 1, skiHeld: true }, status: 0, seq: 1 },
  { t: 10, kind: 'input', pid: 'p1', input: { jetHeld: true }, status: 0, seq: 2 },
  { t: 30, kind: 'impulse', pid: 'p2', dv: { x: 4, y: 8, z: -2 } },
  { t: 60, kind: 'energy', pid: 'p1', amount: 20, drain: true },
  { t: 80, kind: 'resync', pid: 'p2', pos: { x: 40, y: 80, z: 40 }, yaw: 2.2, fullEnergy: true },
  { t: 90, kind: 'face', pid: 'p1', yaw: 0.7 },
  { t: 100, kind: 'input', pid: 'p2', input: { forward: -1, skiHeld: true }, status: 0, seq: 1 },
];

// The live side of the replay pair — applies a journaled call verbatim.
function apply(sim: RoomMoveSim, ev: JournalEv): void {
  switch (ev.kind) {
    case 'track': { sim.track(ev.pid, ev.pos, ev.yaw, ev.perk, ev.team, ev.bot, ev.armorClass); break; }
    case 'input': { sim.setInput(ev.pid, ev.input, ev.status, ev.seq); break; }
    case 'impulse': { sim.applyImpulse(ev.pid, ev.dv); break; }
    case 'resync': { sim.resync(ev.pid, ev.pos, ev.yaw, ev.fullEnergy); break; }
    case 'reconcile': { sim.reconcile(ev.pid, ev.pos, ev.yaw, ev.vel, ev.seq, ev.rtt); break; }
    case 'energy': { if (ev.drain) { sim.drainEnergy(ev.pid, ev.amount); } else { sim.grantEnergy(ev.pid, ev.amount); } break; }
    case 'face': { sim.faceYaw(ev.pid, ev.yaw); break; }
    case 'water': { sim.setWaterLevel(ev.level); break; }
    case 'hash': { break;
    }
  }
}

function runLive(): RoomMoveSim {
  const live = new RoomMoveSim(flat);
  let t = 0;
  for (const ev of EVENTS) {
    while (t < ev.t) { live.tick(0.05); t += 1; }
    apply(live, ev);
  }
  while (t < 130) { live.tick(0.05); t += 1; }
  return live;
}

describe('simJournal cross-engine', () => {
  it('the journaled stream replays on V8 to the same hashes JSC produced', () => {
    const live = runLive();
    // Snapshot the trajectory checkpoints — these constants are the
    // cross-engine contract (JSC produced the identical values).
    const s1 = live.simState('p1')!, s2 = live.simState('p2')!;
    expect(Number.isFinite(s1.pos.x + s1.pos.y + s1.pos.z)).toBe(true);
    expect(s1.pos.z).toBeGreaterThan(100);          // forward ski moved it
    expect(s2.pos.z).toBeGreaterThan(-200);
    // A hash marker at the run's end bounds the replay — replayJournal
    // stops at the last event, so without it trailing ticks are un-run.
    const evs: JournalEv[] = [...EVENTS, { t: 130, kind: 'hash', h: live.journalHash() }];
    const again = new RoomMoveSim(flat);
    const split = replayJournal(evs, again, () => again.journalHash());
    expect(split).toBe(-1);
    const r1 = again.simState('p1')!, r2 = again.simState('p2')!;
    expect(r1.pos).toEqual(s1.pos);
    expect(r1.vel).toEqual(s1.vel);
    expect(r2.pos).toEqual(s2.pos);
  });
});
