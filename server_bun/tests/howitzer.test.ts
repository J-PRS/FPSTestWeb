import { describe, it, expect } from 'bun:test';
import {
  MoveSim, MOVEMENT_CONFIG, type MoveSurface, type MoveState,
} from '../../shared/movement.ts';
import { getWeaponStats, spendAmmo, ammoOf, WeaponType } from '../../shared/weapons.ts';

// Howitzer sim contract — the deploy/ammo/recoil rules that make it a
// real weapon rather than a mortar skin. Each test drives the shared
// sim code the client predicts and the server owns.

const flat: MoveSurface = {
  getHeight: () => 0,
  getNormal: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
const mk = (over: Partial<MoveState> = {}): MoveSim =>
  new MoveSim(flat, {
    pos: { x: 0, y: 1.8, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: true, ...over,
  });
const run = (s: MoveSim, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) {s.update(dt);}
};

const HOW = WeaponType.Howitzer;

describe('howitzer', () => {
  it('row carries the deploy contract: ammo pool, fuse, recoil, ground rule', () => {
    const st = getWeaponStats(HOW);
    expect(st.ammoCap).toBe(5);
    expect(st.ammoRegenMult).toBe(2); // 6s per charge on a 3s interval
    expect(st.ammoAlwaysRegen).toBe(true);
    expect(st.recoilImpulse).toBeGreaterThan(0);
    expect(st.groundedOnly).toBe(true);
    expect(st.fireInterval).toBe(3);
  });

  it('charges accrue during a burst — no per-shot regen freeze', () => {
    const pool = new Map();
    // Fire at t=0 (drum 5->4), then read at t=0.5: ammoAlwaysRegen means
    // the charge clock kept running through the shot.
    expect(spendAmmo(pool, HOW, 0)).toBe(true);
    const mid = ammoOf(pool, HOW, 0.5)!;
    expect(mid).toBeGreaterThan(4); // ~4.083 with constant accrue
    // Control: a weapon WITHOUT the flag (plasma gun) stays floored at
    // the post-shot value for one fire interval.
    const plas = new Map();
    spendAmmo(plas, WeaponType.PlasmaGun, 0);
    // PlasmaGun is a 20-round pool: 20-1, frozen mid-interval.
    expect(ammoOf(plas, WeaponType.PlasmaGun, 0.05)!).toBe(19);
  });

  it('5-spend drum runs dry, regen feeds it back on the 6s clock', () => {
    const pool = new Map();
    for (let i = 0; i < 5; i += 1) {expect(spendAmmo(pool, HOW, 0)).toBe(true);}
    expect(spendAmmo(pool, HOW, 0)).toBe(false); // dry
    // Dry pools trickle at half-cadence regardless; at t=6 one charge
    // should be banked again.
    expect(ammoOf(pool, HOW, 6)!).toBeGreaterThanOrEqual(1);
    expect(spendAmmo(pool, HOW, 6)).toBe(true);
  });

  it('recoil impulse + fallBoost reads as a real fall', () => {
    const sim = mk();
    const recoil = getWeaponStats(HOW).recoilImpulse!;
    // Firing straight up from dirt: the kick plants the shooter down.
    sim.impulse({ x: 0, y: -recoil, z: 0 });
    sim.armFallBoost(3);
    sim.update(1 / 60);
    const landing = sim.landingImpact * sim.fallBoost;
    expect(landing).toBeGreaterThan(MOVEMENT_CONFIG.fallDamageMinSpeed);
  });

  it('fallBoost decays back to 1 within ~0.7s', () => {
    const sim = mk();
    sim.armFallBoost(3);
    run(sim, 0.75);
    expect(sim.fallBoost).toBe(1);
  });

  it('horizontal kick leaves the grounded body grounded (no ghost launch)', () => {
    const sim = mk();
    sim.impulse({ x: -20, y: 0, z: 0 });
    run(sim, 0.3);
    expect(sim.state.onGround).toBe(true);
  });
});
