import { describe, it, expect, afterEach } from 'bun:test';
import { rollSkill, skillMods, weaponAxis, aimSkillFor, driftForm, BOT_TIERS } from '../../shared/botSkill.ts';
import { WeaponType } from '../../shared/weaponTable.ts';
import { botRng } from '../../shared/botRand.ts';
import { sharedEnv } from '../../shared/env.ts';

// rollSkill draws on a private mulberry32 seeded from the spawn point —
// NEVER botRand. Under strictRng any botRand draw would throw, so a
// green roll inside the armed gate is the proof the streams stay
// separate. Same spawn must also give the same matrix (respawn keeps
// a bot's personality).
const spawn = { x: 120, y: 30, z: -55 };

afterEach(() => { sharedEnv.strictRng = false; });

describe('rollSkill stream separation', () => {
  it('rolls under armed strictRng without touching botRand', () => {
    sharedEnv.strictRng = true;
    botRng(Math.random); // armed-but-ambient — any draw throws
    expect(() => rollSkill(spawn)).not.toThrow();
  });

  it('same spawn → same matrix; different spawn → different roll', () => {
    const a = rollSkill(spawn);
    const b = rollSkill(spawn);
    expect(a.axes.snap.moving).toBe(b.axes.snap.moving);
    expect(a.movement).toBe(b.movement);
    expect(a.courage).toBe(b.courage);
    expect(a.beltPull).toBe(b.beltPull);
    const c = rollSkill({ x: 121, y: 30, z: -55 });
    expect(c.axes.snap.moving).not.toBe(a.axes.snap.moving);
  });

  it('every axis clamps into [0.45, 1.5], courage into [0, 1)', () => {
    const s = rollSkill(spawn, 'impossible');
    for (const pair of Object.values(s.axes)) {
      for (const v of [pair.moving, pair.still]) {
        expect(v).toBeGreaterThanOrEqual(0.45);
        expect(v).toBeLessThanOrEqual(1.5);
      }
    }
    expect(s.courage).toBeGreaterThanOrEqual(0);
    expect(s.courage).toBeLessThan(1);
    expect(s.form).toBe(1);
  });
});

describe('skillMods resolution', () => {
  it('undefined and medium resolve to the medium row', () => {
    expect(skillMods(undefined)).toEqual(BOT_TIERS.medium);
    expect(skillMods('medium')).toEqual(BOT_TIERS.medium);
  });

  it('a tier name resolves to that tier row', () => {
    expect(skillMods('impossible')).toEqual(BOT_TIERS.impossible);
  });

  it('a mix borrows per axis and defaults the rest to medium', () => {
    const m = skillMods({ aim: 'impossible', react: 'easy' });
    expect(m.aim).toBe(BOT_TIERS.impossible.aim);
    expect(m.react).toBe(BOT_TIERS.easy.react);
    expect(m.move).toBe(BOT_TIERS.medium.move);
    expect(m.jitter).toBe(BOT_TIERS.medium.jitter);
    expect(m.temper).toBe(BOT_TIERS.medium.temper);
  });
});

describe('weaponAxis + aimSkillFor', () => {
  it('maps each weapon family onto the axis its shots exercise', () => {
    expect(weaponAxis(WeaponType.Railgun)).toBe('snap');
    expect(weaponAxis(WeaponType.Chaingun)).toBe('track');
    expect(weaponAxis(WeaponType.Disc)).toBe('arcLead');
    expect(weaponAxis(WeaponType.Mortar)).toBe('arcJudge');
  });

  it('non-skill weapons return null — always shoot at 1x', () => {
    for (const w of [WeaponType.Melee, WeaponType.Slam, WeaponType.Repair,
      WeaponType.HealBeam, WeaponType.Concussion, WeaponType.ClusterBomblet]) {
      expect(weaponAxis(w)).toBeNull();
      expect(aimSkillFor(rollSkill(spawn), w, 10)).toBe(1);
    }
  });

  it('blends still/moving by target speed and scales by form', () => {
    const s = rollSkill(spawn);
    s.axes.snap = { moving: 1.0, still: 0.5 };
    s.form = 2; // >1 form multiplies straight through
    // targetSpeed 20+ → full moving weight; 0 → pure still
    expect(aimSkillFor(s, WeaponType.Railgun, 20)).toBeCloseTo(2, 9);
    expect(aimSkillFor(s, WeaponType.Railgun, 0)).toBeCloseTo(1, 9);
    // Half speed → halfway between still and moving, times form
    expect(aimSkillFor(s, WeaponType.Railgun, 10)).toBeCloseTo(0.75 * 2, 9);
  });
});

describe('driftForm', () => {
  it('random-walks within [0.85, 1.15] and consumes the private stream', () => {
    const s = rollSkill(spawn);
    s.form = 1.14;
    for (let i = 0; i < 200; i++) { driftForm(s, 1); }
    expect(s.form).toBeLessThanOrEqual(1.15);
    s.form = 0.86;
    for (let i = 0; i < 200; i++) { driftForm(s, 1); }
    expect(s.form).toBeGreaterThanOrEqual(0.85);
  });

  it('respects the armed strictRng gate — drift draws private, not ambient', () => {
    sharedEnv.strictRng = true;
    botRng(Math.random);
    const s = rollSkill(spawn);
    expect(() => { for (let i = 0; i < 50; i++) { driftForm(s, 1); } }).not.toThrow();
  });
});
