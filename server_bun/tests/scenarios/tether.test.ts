import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';
import { tetherSlow } from '../../../shared/movement.ts';

describe('tether speed curve', () => {
  it('full stop to 20 m/s, 20% at 60, nothing from 80 up', () => {
    expect(tetherSlow(5)).toBe(1);
    expect(tetherSlow(20)).toBe(1);
    expect(tetherSlow(40)).toBeCloseTo(0.6, 9);
    expect(tetherSlow(60)).toBeCloseTo(0.2, 9);
    expect(tetherSlow(70)).toBeCloseTo(0.1, 9);
    expect(tetherSlow(80)).toBe(0);
    expect(tetherSlow(120)).toBe(0);
  });
});

describe('scenario: tether snare', () => {
  // The enemy starts on the rim and is shoved outward at 40 m/s (f = 0.6/s),
  // so it is out of the ring within a tick. Breaking free zaps jet energy;
  // a teammate on the same ring is untouched.
  function setup(sideOfRunner: 'bravo' | 'alpha') {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    room.players.addPlayer('runner', sideOfRunner, 'none', 'medium');
    const engi = room.players.getPlayer('engi')!;
    pin(room, 'engi', { x: 20, y: 0, z: 0 });
    engi.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'tether', { x: 30, y: 0, z: 0 })).toBe(true);
    room.moveSim.track('runner', { x: 35.8, y: 0, z: 0 }, 0, undefined, sideOfRunner);
    pin(room, 'runner', { x: 35.8, y: 0, z: 0 });
    room.moveSim.applyImpulse('runner', { x: 40, y: 0, z: 0 });
    return room;
  }

  it('an enemy breaking out of the ring pays an energy zap', () => {
    const room = setup('bravo');
    const before = room.moveSim.energyOf('runner')!;
    step(room, 4);
    expect(room.moveSim.energyOf('runner')!).toBeLessThan(before - 5);
  });

  it('a teammate walks the same ring untouched', () => {
    const room = setup('alpha');
    const before = room.moveSim.energyOf('runner')!;
    step(room, 4);
    expect(room.moveSim.energyOf('runner')!).toBeGreaterThanOrEqual(before - 0.5);
  });
});
