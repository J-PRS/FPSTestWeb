import { describe, expect, it, vi } from 'vitest';
import { applyStatus, dropSkill, fuelTick } from '../game/botEnergy.js';
import { ENERGY } from '../../../shared/movement.js';
import { STATUS } from '../../../shared/status.js';
import type { GameBot } from '../game/botBrain.js';

const mkBot = (energy = 100) => ({
  status: 0,
  energy,
  energyCap: 100,
  botHp: 80,
  botMaxHp: 100,
  yeetT: 0,
  isDead: false,
  velocity: { x: 0, y: 0, z: 0 },
  moveState: { onGround: true } as GameBot['moveState'],
  mods: { regen: 0, jetDrain: 1, jetRegen: 1, energyRegen: 1 } as GameBot['mods'],
  heal: vi.fn(),
  setMending: vi.fn(),
  setShielded: vi.fn(),
  setCloakHidden: vi.fn(),
}) as unknown as GameBot;

describe('applyStatus', () => {
  it('rising-edge activation costs are paid per bit', () => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND | STATUS.SHIELD, 0.1);
    expect(b.status).toBe(STATUS.MEND | STATUS.SHIELD);
    expect(b.energy).toBeCloseTo(100 - ENERGY.mendCost - ENERGY.shieldCost - ENERGY.mendDrain * 0.1 - ENERGY.shieldDrain * 0.1, 5);
  });

  it('holding a bit across calls charges no activation again', () => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND, 0.1);
    const afterFirst = b.energy;
    applyStatus(b, STATUS.MEND, 0.1); // only the held drain now
    expect(afterFirst - b.energy).toBeCloseTo(ENERGY.mendDrain * 0.1, 5);
  });

  it('unaffordable bits are silently dropped from the claim', () => {
    const b = mkBot(5); // below every activation cost
    applyStatus(b, STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK, 0.1);
    expect(b.status).toBe(0);
  });

  it('a held drain that empties the tank drops the skill', () => {
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

  it('mend channel heals at the server rate and clamps at max hp', () => {
    const b = mkBot(100);
    b.botHp = 95;
    applyStatus(b, STATUS.MEND, 1);
    expect(b.botHp).toBe(100);
  });

  it('cloak drain scales with horizontal speed', () => {
    const slow = mkBot(100);
    const fast = mkBot(100);
    fast.velocity.x = ENERGY.cloakDrainSpeedMps; // max-drain speed
    applyStatus(slow, STATUS.CLOAK, 1);
    applyStatus(fast, STATUS.CLOAK, 1);
    expect(fast.energy).toBeLessThan(slow.energy);
  });

  it('non-status bits in the claim never latch', () => {
    const b = mkBot(100);
    applyStatus(b, STATUS.MEND | 0x400, 0.1);
    expect(b.status & 0x400).toBe(0);
  });
});

describe('dropSkill', () => {
  it('clears the bit and the matching visual flag', () => {
    const b = mkBot();
    b.status = STATUS.SHIELD;
    dropSkill(b, STATUS.SHIELD);
    expect(b.status).toBe(0);
    expect(b.setShielded).toHaveBeenCalledWith(false);
  });
});

describe('fuelTick', () => {
  it('jets drain while thrusting; yeet rides free but grounded regen still applies', () => {
    const b = mkBot(50);
    fuelTick(b, 1, true);
    expect(b.energy).toBeCloseTo(50 - ENERGY.jetDrain, 5);
    const c = mkBot(50);
    c.yeetT = 0.5;
    fuelTick(c, 1, true); // no jet drain during yeet — grounded regen instead
    expect(c.energy).toBeCloseTo(50 + ENERGY.jetCharge, 5);
    c.moveState.onGround = false;
    c.energy = 50;
    fuelTick(c, 1, true); // airborne yeet: neither drain nor regen
    expect(c.energy).toBe(50);
  });

  it('grounded-and-idle regens toward the cap, airborne does not', () => {
    const b = mkBot(50);
    fuelTick(b, 1, false);
    expect(b.energy).toBeCloseTo(50 + ENERGY.jetCharge, 5);
    fuelTick(b, 100, false);
    expect(b.energy).toBe(100); // cap
    b.moveState.onGround = false;
    b.energy = 50;
    fuelTick(b, 1, false);
    expect(b.energy).toBe(50);
  });
});
