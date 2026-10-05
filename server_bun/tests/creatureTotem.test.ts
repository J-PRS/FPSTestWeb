import { it, expect } from 'bun:test';
import {
  makeSimTotem, stepTotem, applyTotemDamage,
  totemSolveBeam, totemBeamHit, totemFireTargets,
  TOTEM_SIM, TOTEM_SPECIES,
} from '../../shared/creatureTotem.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { SPECIES } from '../../shared/species.ts';

// The obelisk's wire story: it never walks — it BLINKS (peak-seek) and
// fires a hitscan rail down a COMMITTED line. 'charge' carries the lock,
// 'fire' resolves vs LIVE positions, 'blink'/'land' bookend relocation.
// Pins: aim→charge→fire cycle, relocation triggers, stagger pin,
// blink intangibility, beam geometry, twin replay.

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimTotem(1, { x, y: 0, z }, false, 42);

const stepTo = (c: ReturnType<typeof mk>, target: { x: number; y: number; z: number } | null, authoritative = false, cols?: StructureCollider[]) =>
  stepTotem(c, DT, FLAT, target, authoritative, cols);

it('totem species come from the unified registry — totem row exists', () => {
  expect(TOTEM_SPECIES.totem).toBeDefined();
  for (const [name, row] of Object.entries(TOTEM_SPECIES)) {
    expect(SPECIES[name], name).toBe(row);
    expect(row.family).toBe('totem');
  }
});

it('uber mirrors the crowned elder — slower refire, longer telegraph, wider catch, taller eye', () => {
  const u = makeSimTotem(1, { x: 0, y: 0, z: 0 }, true, 42);
  const row = SPECIES.totem!;
  expect(u.health).toBeCloseTo(row.health * 2.5, 6);
  expect(u.biteDamage).toBe(row.bite * 2);
  expect(u.sp.REFIRE).toBe(4.5);
  expect(u.sp.CHARGE).toBe(1.0);
  expect(u.hitR2).toBeCloseTo(1.5 * 1.5, 9);
  expect(u.radius).toBe(1.8);
});

it('a target in range with a ready clock locks — charge edge + committed beam', () => {
  const c = mk();
  c.windupTimer = 0;
  // chest-height target — a feet-level lock grazes terrain in the last
  // samples (line-clear fails) and the obelisk relocates instead
  const ev = stepTo(c, { x: 50, y: 2, z: 0 });
  expect(ev).toBe('charge');
  expect<string>(c.state).toBe('charge');
  expect(c.hopTimer).toBeCloseTo(TOTEM_SIM.CHARGE, 9);
  // beam is committed now — direction toward the snapshot point
  expect(c.lockDirX).toBeGreaterThan(0.9);
  expect(c.lockDist).toBeGreaterThan(0);
});

it('no charge while the refire clock runs — the aim state just idles', () => {
  const c = mk();
  c.windupTimer = 2; // fresh spawn is already 2.6
  const ev = stepTo(c, { x: 50, y: 0, z: 0 });
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('aim');
});

it('out-of-range target never locks', () => {
  const c = mk();
  c.windupTimer = 0;
  const ev = stepTo(c, { x: 200, y: 2, z: 0 }); // past RANGE=105, level line stays clear
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('aim');
});

it('charge completes into fire — edge, refire rearmed, shot counted', () => {
  const c = mk();
  c.state = 'charge';
  c.hopTimer = DT;
  const ev = stepTo(c, { x: 50, y: 0, z: 0 }, true);
  expect(ev).toBe('fire');
  expect<string>(c.state).toBe('aim');
  expect(c.windupTimer).toBeCloseTo(TOTEM_SIM.REFIRE, 9);
  expect(c.shotsFired).toBe(1);
  expect(c.pendingBite).toBe(true);
  // predictor emits the edge but never the damage flag
  const p = mk();
  p.state = 'charge';
  p.hopTimer = DT;
  expect(stepTo(p, { x: 50, y: 0, z: 0 }, false)).toBe('fire');
  expect(p.pendingBite).toBe(false);
});

it('a too-close player forces a blink — MIN_RANGE relocation', () => {
  const c = mk();
  const ev = stepTo(c, { x: 10, y: 0, z: 0 }); // inside MIN_RANGE=22
  expect(ev).toBe('blink');
  expect<string>(c.state).toBe('blinkOut');
  expect(c.hopTimer).toBeCloseTo(TOTEM_SIM.BLINK_OUT_S, 9);
  // destination was committed (flank or perch)
  expect(c.blinkX !== 0 || c.blinkZ !== 0).toBe(true);
});

it('shot budget forces relocation after RELOCATE_SHOTS', () => {
  const c = mk();
  c.shotsFired = TOTEM_SIM.RELOCATE_SHOTS;
  c.blinkCd = 0;
  const ev = stepTo(c, { x: 60, y: 0, z: 0 });
  expect(ev).toBe('blink');
  expect<string>(c.state).toBe('blinkOut');
});

it('blinkOut snaps to the committed point, blinkIn lands back in aim', () => {
  const c = mk(0, 0);
  c.state = 'blinkOut';
  c.hopTimer = DT;
  c.blinkX = 30; c.blinkY = 5; c.blinkZ = 15;
  stepTo(c, null);
  expect(c.x).toBe(30);
  expect(c.z).toBe(15);
  expect(c.y).toBe(0); // snapped to the terrain height
  expect<string>(c.state).toBe('blinkIn');
  c.hopTimer = DT;
  const ev = stepTo(c, null);
  expect(ev).toBe('land');
  expect<string>(c.state).toBe('aim');
  expect(c.shotsFired).toBe(0); // shot budget resets on the new perch
  expect(c.blinkCd).toBeGreaterThanOrEqual(TOTEM_SIM.BLINK_CD_MIN);
  expect(c.blinkCd).toBeLessThanOrEqual(TOTEM_SIM.BLINK_CD_MIN + TOTEM_SIM.BLINK_CD_VAR);
});

it('a mid-blink totem is intangible — damage returns false, nothing sticks', () => {
  for (const s of ['blinkOut', 'blinkIn'] as const) {
    const c = mk();
    c.state = s;
    const hp = c.health;
    expect(applyTotemDamage(c, 999)).toBe(false);
    expect(c.health).toBe(hp);
    expect(c.dead).toBe(false);
  }
});

it('damage pins the obelisk — stagger blocks relocation while stunned', () => {
  const c = mk();
  applyTotemDamage(c, 1);
  expect(c.stunTimer).toBeCloseTo(TOTEM_SIM.STAGGER_S, 9);
  // too-close target + stunned → NO blink
  const ev = stepTo(c, { x: 5, y: 0, z: 0 });
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('aim');
});

it('blink cooldown blocks chain escapes even with a close target', () => {
  const c = mk();
  c.blinkCd = 3;
  const ev = stepTo(c, { x: 5, y: 0, z: 0 });
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('aim');
});

it('totemSolveBeam commits the line — unit dir, terrain-clipped dist', () => {
  const c = mk();
  totemSolveBeam(c, FLAT, 50, c.y + TOTEM_SIM.EYE_HEIGHT, 0); // level shot
  expect(c.lockDirX).toBeCloseTo(1, 5);
  expect(c.lockDist).toBe(TOTEM_SIM.RANGE); // flat field never clips
});

it('a structure in the beam path clips lockDist', () => {
  const c = mk();
  const wall: StructureCollider = { cx: 20, cy: 5, cz: 0, hx: 1, hy: 10, hz: 10, cos: 1, sin: 0 };
  totemSolveBeam(c, FLAT, 80, c.y + TOTEM_SIM.EYE_HEIGHT, 0, [wall]);
  expect(c.lockDist).toBeLessThan(TOTEM_SIM.RANGE);
});

it('totemBeamHit catches a body on the line, misses beside/behind/past the clip', () => {
  const c = mk();
  const eye = c.y + TOTEM_SIM.EYE_HEIGHT;
  totemSolveBeam(c, FLAT, 50, eye, 0);
  expect(totemBeamHit(c, 30, eye, 0)).toBe(true);          // on the line
  expect(totemBeamHit(c, 30, eye, 5)).toBe(false);         // off-axis
  expect(totemBeamHit(c, -10, eye, 0)).toBe(false);        // behind the eye
  expect(totemBeamHit(c, 200, eye, 0)).toBe(false);        // past lockDist
});

it('totemFireTargets sweeps live positions — the sidestep counterplay whiffs', () => {
  const c = mk();
  const eye = c.y + TOTEM_SIM.EYE_HEIGHT;
  totemSolveBeam(c, FLAT, 50, eye, 0);
  const hits = totemFireTargets(c, [
    { id: 'on-line', pos: { x: 40, y: eye - 1.0, z: 0 } },   // +1 chest = eye height
    { id: 'dodged', pos: { x: 40, y: eye - 1.0, z: 8 } },    // sidestepped
  ]);
  expect(hits).toEqual(['on-line']);
});

it('two totems stepped identically stay bit-identical — replay holds', () => {
  const a = mk(0, 0), b = mk(0, 0);
  const target = { x: 55, y: 0, z: 10 };
  for (let i = 0; i < 400; i++) {
    expect(stepTo(a, target)).toBe(stepTo(b, target));
  }
  for (const k of ['x', 'y', 'z', 'state', 'windupTimer', 'shotsFired', 'blinkCd', 'lockDirX', 'lockDirY', 'lockDirZ', 'lockDist', 'blinkX', 'blinkZ', 'rng'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});
