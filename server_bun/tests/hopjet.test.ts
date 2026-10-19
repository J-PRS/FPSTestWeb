import { describe, expect, test } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { BotMoves } from '../../shared/botMoves.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

/**
 * Hop→jet timing sweep — JP's question: does a jump + jet tap beat a
 * held flat burn, and where in the hop arc does the tap land best?
 *
 * Method: one shadow on a dead-flat field, scripted key-level inputs.
 * Every landing arms a jump (autohop chain); the jet tap fires for a
 * fixed window starting `delay` seconds after takeoff. Compared against
 * three controls: ski only, held jet burn, hop chain without jet.
 * Measured: distance/speed over a fixed window and energy per meter —
 * the trick only pays if it's faster per tank point, not just faster.
 */

const flat: Heightfield = { size: 2, data: new Uint8Array(4), stride: 1 };
const DT = 1 / 30;
const RUN_S = 20;
interface Result { speed: number; dist: number; ePerM: number; enSpent: number }

function run(opts: { hop: boolean; jetMode: 'none' | 'held' | 'tap'; tapDelay?: number; tapDur?: number }): Result {
  const tapDur = opts.tapDur ?? 0.3;
  const m = new RoomMoveSim(flat);
  m.track('p', { x: 0, y: 2, z: 0 }, 0);
  const e0 = m.energyOf('p') ?? 0;
  let airT = Infinity; // time since last takeoff — the tap's clock
  let wasGround = true;
  const z0 = 0;
  const steps = Math.round(RUN_S / DT);
  for (let i = 0; i < steps; i++) {
    const st = m.simState('p')!;
    const ground = st.pos.y <= 2.05; // eye offset on flat — contact band
    if (wasGround && !ground) {airT = 0;} // takeoff edge
    if (!ground) {airT += DT;}
    wasGround = ground;
    const airborne = !ground;
    const jet = opts.jetMode === 'held'
      || (opts.jetMode === 'tap' && airborne && airT >= (opts.tapDelay ?? 0) && airT < (opts.tapDelay ?? 0) + tapDur);
    m.setInput('p', {
      forward: 1, right: 0,
      jumpHeld: opts.hop && ground,   // autohop: press when touching
      jumpPressed: false,
      skiHeld: true,
      jetHeld: jet,
    });
    m.tick(DT);
  }
  const st = m.simState('p')!;
  const dist = st.pos.z - z0;
  const enSpent = e0 - (m.energyOf('p') ?? 0);
  return { speed: dist / RUN_S, dist, ePerM: enSpent / Math.max(1, dist), enSpent };
}

interface MovesResult { speed: number; enSpent: number; tailTicks: number }

/** The same flat transit driven through the real BotMoves path — a
 *  route-committed runner with moveSkill either above or below the
 *  tail-tap gate. Confirms the sweep's winner actually rides the
 *  brain's inputs, not just scripted keys. */
function runMoves(moveSkill: number | undefined): MovesResult {
  const m = new RoomMoveSim(flat);
  const moves = new BotMoves({ escapeJetT: () => 0, huntPos: () => null });
  m.track('p', { x: 0, y: 2, z: 0 }, 0);
  const e0 = m.energyOf('p') ?? 0;
  const objective = { x: 0, y: 2, z: 2000 };
  let tailTicks = 0;
  const steps = Math.round(RUN_S / DT);
  for (let i = 0; i < steps; i++) {
    const st = m.simState('p')!;
    const ctx = {
      pos: st.pos, vel: st.vel, enemies: [],
      objective, runner: true,
      energy: m.energyOf('p') ?? 0,
      groundY: () => 0,
      moveSkill,
      now: i * DT * 1000,
    };
    const hint = moves.hints(DT, ctx, st.pos, objective) ?? { ski: false, jet: false, jump: false };
    if (moves.jetWhy === 'tail') {tailTicks++;}
    m.setInput('p', {
      forward: 1, right: 0,
      jumpHeld: hint.jump, jumpPressed: false,
      skiHeld: hint.ski, jetHeld: hint.jet,
    });
    m.tick(DT);
  }
  const st = m.simState('p')!;
  return { speed: st.pos.z / RUN_S, enSpent: e0 - (m.energyOf('p') ?? 0), tailTicks };
}

describe('hop→jet timing', () => {
  const ski = run({ hop: false, jetMode: 'none' });
  const burn = run({ hop: false, jetMode: 'held' });
  const hops = run({ hop: true, jetMode: 'none' });
  const taps = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45].map((d) => ({ d, r: run({ hop: true, jetMode: 'tap', tapDelay: d }) }));
  const durSweep = [0.15, 0.3, 0.5].flatMap((dur) =>
    [0.1, 0.2, 0.3, 0.4].map((d) => ({ d, dur, r: run({ hop: true, jetMode: 'tap', tapDelay: d }) })));

  test('physics sanity: burn beats ski, hop chain beats walk', () => {
    expect(burn.speed).toBeGreaterThan(ski.speed);
    expect(hops.speed).toBeGreaterThan(ski.speed * 0.8); // hops ≈ ski at minimum
  });

  test('skilled runner rides the descent tap; unskilled pays the burn', () => {
    const skilled = runMoves(1.5);
    const plain = runMoves(0.5);
    console.log(`botMoves skilled  spd=${skilled.speed.toFixed(1)} enSpent=${skilled.enSpent.toFixed(0)} tailTicks=${skilled.tailTicks}`);
    console.log(`botMoves unskilled spd=${plain.speed.toFixed(1)} enSpent=${plain.enSpent.toFixed(0)} tailTicks=${plain.tailTicks}`);
    expect(skilled.tailTicks).toBeGreaterThan(0);
    expect(plain.tailTicks).toBe(0);
    // Post-cruise-burn (182bd8e9) the PLAIN runner transits at ~42m/s too
    // — the grounded cruise fires for any runner, so the tap no longer
    // doubles pace: the floor moved up under it. The remaining contract
    // is the tap still fires on skilled transit and holds parity at the
    // shared ceiling (its real value: airborne acceleration the grounded
    // burn can't reach). The scripted sweep above carries e/m.
    expect(skilled.speed).toBeGreaterThan(plain.speed * 0.9);
  });

  test('prints the sweep table', () => {
    console.log(`ski-only      spd=${ski.speed.toFixed(1)} enSpent=${ski.enSpent.toFixed(0)} e/m=${ski.ePerM.toFixed(3)}`);
    console.log(`held-burn     spd=${burn.speed.toFixed(1)} enSpent=${burn.enSpent.toFixed(0)} e/m=${burn.ePerM.toFixed(3)}`);
    console.log(`hop-chain     spd=${hops.speed.toFixed(1)} enSpent=${hops.enSpent.toFixed(0)} e/m=${hops.ePerM.toFixed(3)}`);
    for (const { d, r } of taps) {
      console.log(`hop+tap@${(d * 1000).toFixed(0).padStart(3)}ms spd=${r.speed.toFixed(1)} enSpent=${r.enSpent.toFixed(0)} e/m=${r.ePerM.toFixed(3)}`);
    }
    for (const { d, dur, r } of durSweep) {
      console.log(`hop+tap ${dur.toFixed(2)}s@${(d * 1000).toFixed(0).padStart(3)}ms spd=${r.speed.toFixed(1)} enSpent=${r.enSpent.toFixed(0)} e/m=${r.ePerM.toFixed(3)}`);
    }
  });
});
