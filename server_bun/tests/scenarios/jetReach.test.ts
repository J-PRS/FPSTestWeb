import { describe, it, expect } from 'bun:test';
import { mkRoom, flat, step } from './harness.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { CLASS_STATS, type ArmorClass } from '../../../shared/botClasses.ts';
import { ENERGY, type MoveInput } from '../../../shared/movement.ts';

// Jet-reach baseline: each armor class stands on the flat arena and holds
// the jet button until the tank runs dry — measured twice, once from
// standstill and once with a jump to seed the climb. Peak
// eye-height-above-stand and first-empty time get recorded — the numbers
// ARE the report; the asserts only guard the invariants (fuel law, mass
// ordering, and the standstill dead-zone).
//
// Measured baseline (masses 1.0/1.15/1.2 — every tier under the 35/28
// hover threshold so the pack can lift off a stand):
//   standstill + jumpstart heights are printed by the console line below;
//   asserts pin the invariants, not the tuning numbers.

const FLOOR = hmHeight(flat, 0, 0);
const DT = 0.05;
const CLASSES = ['light', 'medium', 'heavy'] as const;

interface Trial { height: number; dryAt: number }

function jetTrial(cls: ArmorClass, input: Partial<MoveInput>): Trial {
  const room = mkRoom({ bots: 0 }, 'dm');
  const st = CLASS_STATS[cls];
  const p = room.players.addPlayer(`p-${cls}`, undefined, 'none', cls);
  p.position = { x: 0, y: FLOOR + st.eyeHeight, z: 0 };
  // addPlayer doesn't seed a move shadow — humans get one via the join
  // message path; here the sim has to be tracked + bodied like the
  // roster's applyClass does, or the jet thrust divides by mass 1.
  room.moveSim.track(p.id, p.position, 0, p.perk);
  room.moveSim.setSpeedScale(p.id, st.speedScale);
  room.moveSim.setBody(p.id, st.mass, st.eyeHeight, st.radius);
  room.moveSim.setInput(p.id, input);

  let peak = p.position.y, dryAt = -1;
  for (let i = 0; i < 400; i++) { // 20 sim-seconds — long past any tank
    // First-empty time is the fuel-law check: after that the tank
    // sputters (regen 8/s vs drain 15/s), so "ticks with fuel" would
    // measure the equilibrium flicker, not the burn.
    if (dryAt < 0 && (room.moveSim.energyOf(p.id) ?? 0) <= 0) dryAt = i * DT;
    step(room, 1, DT);
    const y = room.moveSim.simState(p.id)!.pos.y;
    if (y > peak) peak = y;
  }
  return { height: peak - (FLOOR + st.eyeHeight), dryAt };
}

describe('scenario: jet reach per class', () => {
  const standstill = new Map<ArmorClass, Trial>();
  const jumpstart = new Map<ArmorClass, Trial>();
  for (const cls of CLASSES) {
    standstill.set(cls, jetTrial(cls, { jetHeld: true }));
    jumpstart.set(cls, jetTrial(cls, { jumpHeld: true, jetHeld: true }));
  }
  const fmt = (m: Map<ArmorClass, Trial>) =>
    [...m].map(([c, t]) => `${c}=${t.height.toFixed(2)}m (dry ${t.dryAt.toFixed(1)}s)`).join('  ');
  // eslint-disable-next-line no-console
  console.log(`jet reach standstill: ${fmt(standstill)}\njet reach jumpstart:  ${fmt(jumpstart)}`);

  it('every class burns the same tank dry in ~4s — both modes', () => {
    // 60 energy ÷ 15/s drain — the fuel law is class-blind by design;
    // only thrust accel differs (mass). ±0.1s for tick granularity.
    for (const m of [standstill, jumpstart])
      for (const [, t] of m) expect(t.dryAt).toBeCloseTo(ENERGY.max / ENERGY.jetDrain, 1);
  });

  it('standstill: every class lifts off — and orders by mass', () => {
    // Masses sit under the hover threshold (35/m > 28 needs m < 1.25),
    // so the pack launches from a stand now. Light should get real
    // altitude; heavy just needs to break the dead-zone — and the
    // ordering must stay strict.
    for (const cls of CLASSES) expect(standstill.get(cls)!.height).toBeGreaterThan(1);
    expect(standstill.get('light')!.height).toBeGreaterThan(20);
    expect(standstill.get('light')!.height).toBeGreaterThan(standstill.get('medium')!.height);
    expect(standstill.get('medium')!.height).toBeGreaterThan(standstill.get('heavy')!.height);
  });

  it('jumpstart: reach orders by mass — light > medium > heavy', () => {
    // Strict ordering — a tie would mean mass stopped mattering to
    // thrust. The light actually climbs (~28m); mid and heavy just
    // stretch the hop's apex.
    expect(jumpstart.get('light')!.height).toBeGreaterThan(jumpstart.get('medium')!.height);
    expect(jumpstart.get('medium')!.height).toBeGreaterThan(jumpstart.get('heavy')!.height);
    expect(jumpstart.get('light')!.height).toBeGreaterThan(20); // ~4s of sustained 7 m/s
  });

  it('no tank is magic — nobody climbs forever', () => {
    // 20s of held jet can't produce runaway altitude: once dry there's
    // only gravity. Peak must sit under the no-drag ballistic ceiling.
    for (const m of [standstill, jumpstart])
      for (const [, t] of m) expect(t.height).toBeLessThan(500);
  });
});
