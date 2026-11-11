import { describe, expect, it, vi } from 'vitest';
import { applyStatus, dropSkill, fuelTick } from '../game/bots/botEnergy.js';
import { GameBot } from '../game/bots/botBrain.js';
import * as THREE from 'three';
import { ENERGY } from '../../../shared/movement.js';
import { STATUS } from '../../../shared/status.js';
import { perkMods } from '../../../shared/perks.js';

const mkBot = (energy = 100): GameBot => ({
  status: 0,
  energy,
  energyCap: 100,
  botHp: 80,
  botMaxHp: 100,
  propelJetT: 0,
  isDead: false,
  velocity: { x: 0, y: 0, z: 0 },
  moveState: { onGround: true } as GameBot['moveState'],
  mods: { regen: 0, jetDrain: 1, jetRegen: 1, energyRegen: 1 } as GameBot['mods'],
  heal: vi.fn(),
  setMending: vi.fn(),
  setShielded: vi.fn(),
  setCloakHidden: vi.fn(),
  setCloakGhosted: vi.fn(),
}) as unknown as GameBot;

describe('applyStatus', (): void => {
  it('rising-edge activation costs are paid per bit', (): void => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND | STATUS.SHIELD, 0.1);
    expect(b.status).toBe(STATUS.MEND | STATUS.SHIELD);
    expect(b.energy).toBeCloseTo(100 - ENERGY.mendCost - ENERGY.shieldCost - ENERGY.mendDrain * 0.1 - ENERGY.shieldDrain * 0.1, 5);
  });

  it('holding a bit across calls charges no activation again', (): void => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND, 0.1);
    const afterFirst = b.energy;
    applyStatus(b, STATUS.MEND, 0.1); // only the held drain now
    expect(afterFirst - b.energy).toBeCloseTo(ENERGY.mendDrain * 0.1, 5);
  });

  it('unaffordable bits are silently dropped from the claim', (): void => {
    const b = mkBot(5); // below every activation cost
    applyStatus(b, STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK, 0.1);
    expect(b.status).toBe(0);
  });

  it('a held drain that empties the tank drops the skill', (): void => {
    const b = mkBot(ENERGY.mendCost + 1); // barely affords the activation
    applyStatus(b, STATUS.MEND, 0.1); // pays cost + drains — starving the same call drops it
    expect(b.status & STATUS.MEND).toBe(0);
    expect(b.energy).toBe(0);
    const c = mkBot(100);
    applyStatus(c, STATUS.MEND, 0.1);
    expect(c.status & STATUS.MEND).toBe(STATUS.MEND);
    applyStatus(c, STATUS.MEND, 10); // drain far exceeds the remaining energy
    expect(c.status & STATUS.MEND).toBe(0);
    expect(c.energy).toBe(0);
    expect(c.setMending).toHaveBeenLastCalledWith(false);
  });

  it('mend channel heals at the server rate and clamps at max hp', (): void => {
    const b = mkBot(100);
    b.botHp = 95;
    applyStatus(b, STATUS.MEND, 1);
    expect(b.botHp).toBe(100);
  });

  it('cloak drain scales with horizontal speed', (): void => {
    const slow = mkBot(100);
    const fast = mkBot(100);
    fast.velocity.x = ENERGY.cloakDrainSpeedMps; // max-drain speed
    applyStatus(slow, STATUS.CLOAK, 1);
    applyStatus(fast, STATUS.CLOAK, 1);
    expect(fast.energy).toBeLessThan(slow.energy);
  });

  it('non-status bits in the claim never latch', (): void => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND | 0x4_00, 0.1);
    expect(b.status & 0x4_00).toBe(0);
  });
});

describe('dropSkill', (): void => {
  it('clears the bit and the matching visual flag', (): void => {
    const b = mkBot();
    b.status = STATUS.SHIELD;
    dropSkill(b, STATUS.SHIELD);
    expect(b.status).toBe(0);
    expect(b.setShielded).toHaveBeenCalledWith(false);
  });
});

describe('fuelTick', (): void => {
  it('jets drain while thrusting; regen applies anywhere off throttle', (): void => {
    const b = mkBot(50);
    fuelTick(b, 1, true);
    expect(b.energy).toBeCloseTo(50 - ENERGY.jetDrain, 5);
    const c = mkBot(50);
    fuelTick(c, 1, false);
    expect(c.energy).toBeCloseTo(50 + ENERGY.jetCharge, 5);
    // Player rule: airborne still regens — only jets/channels starve it.
    c.moveState.onGround = false;
    c.energy = 50;
    fuelTick(c, 1, false);
    expect(c.energy).toBeCloseTo(50 + ENERGY.jetCharge, 5);
  });

  it('regens toward the cap; a held channel suppresses regen', (): void => {
    const b = mkBot(50);
    fuelTick(b, 1, false);
    expect(b.energy).toBeCloseTo(50 + ENERGY.jetCharge, 5);
    fuelTick(b, 100, false);
    expect(b.energy).toBe(100); // cap
    b.energy = 50;
    b.status = STATUS.SHIELD;
    fuelTick(b, 1, false);
    expect(b.energy).toBe(50); // channel competes for the tank, never fills it
  });
});

describe('takeDamageLocal - zero damage gate', (): void => {
  it('a soaked-to-nothing splash returns false, moves no hp, and never flinches', (): void => {
    // Prototype-borrow (botFire.ts pattern): takeDamageLocal only reads
    // isDead/mods/status/energy/botHp and writes botHp/brain/flinch on
    // the real-damage path - the zero branch must touch none of them.
    const flinch = vi.fn();
    const takeHit = vi.fn();
    const bot = {
      isDead: false,
      botHp: 100, botMaxHp: 100,
      status: 0, energy: 0,
      mods: perkMods('none'),
      brain: { takeHit },
      flinch,
      lastHitAt: 0,
    } as unknown as GameBot;
    expect(GameBot.prototype.takeDamageLocal.call(bot, 0, new THREE.Vector3())).toBe(false);
    expect(bot.botHp).toBe(100);
    expect(flinch).not.toHaveBeenCalled();
    expect(takeHit).not.toHaveBeenCalled();
  });

  it('a shield that soaks the whole hit flinches nothing either', (): void => {
    const flinch = vi.fn();
    const bot = {
      isDead: false,
      botHp: 100, botMaxHp: 100,
      status: STATUS.SHIELD, energy: 100, energyCap: 100,
      mods: perkMods('none'),
      brain: { takeHit: vi.fn() },
      flinch,
      dropSkill: vi.fn(),
      lastHitAt: 0,
    } as unknown as GameBot;
    expect(GameBot.prototype.takeDamageLocal.call(bot, 10, new THREE.Vector3())).toBe(false);
    expect(bot.botHp).toBe(100);
    expect(flinch).not.toHaveBeenCalled();
  });

  it('real damage still flinches (the gate is not a blanket drop)', (): void => {
    const flinch = vi.fn();
    const bot = {
      isDead: false,
      botHp: 100, botMaxHp: 100,
      status: 0, energy: 0,
      mods: perkMods('none'),
      brain: { takeHit: vi.fn() },
      flinch,
      lastHitAt: 0,
    } as unknown as GameBot;
    GameBot.prototype.takeDamageLocal.call(bot, 25, new THREE.Vector3());
    expect(bot.botHp).toBeLessThan(100);
    expect(flinch).toHaveBeenCalled();
  });
});
