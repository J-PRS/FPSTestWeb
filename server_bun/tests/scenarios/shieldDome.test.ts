import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { Vec3 } from '../../src/types.ts';

// The barrier deployable (kind 'shield') is a 6m dome: enemy shells must
// die at the field edge and the blast must not reach anyone inside.

describe('scenario: shield dome blocks enemy fire', () => {
  it('a bolt fired through the dome never reaches the player inside', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const players = [...room.players.getAllPlayers().values()];
    const alpha = players.find((p) => p.team === 'alpha')!;
    const bravo = players.find((p) => p.team === 'bravo')!;

    // Bravo drops the dome on himself; alpha fires a bolt straight at him.
    freeze(room, bravo.id, { x: 0, y: 31, z: 0 });
    room.deployables.handleDeploy(bravo.id, 'shield', { x: 0, y: 31, z: 0 });
    const shield = room.deployables.snapshot().find((d) => d.kind === 'shield');
    expect(shield).toBeTruthy();

    const hp0 = bravo.health;
    for (let i = 0; i < 120; i++) {
      freeze(room, alpha.id, { x: -40, y: 31, z: 0 });
      freeze(room, bravo.id, { x: 0, y: 31, z: 0 });
      step(room, 1);
    }
    room.projectiles.spawn(alpha.id, WeaponType.BoltLauncher,
      { x: -40, y: 31, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 90; i++) {
      freeze(room, alpha.id, { x: -40, y: 31, z: 0 });
      freeze(room, bravo.id, { x: 0, y: 31, z: 0 });
      step(room, 1);
    }
    expect(bravo.health).toBe(hp0); // dome ate the shell — no damage inside
    expect(w.count('playerHit')).toBe(0);
  });

  it('the dome blocks hitscan beams too', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const players = [...room.players.getAllPlayers().values()];
    const alpha = players.find((p) => p.team === 'alpha')!;
    const bravo = players.find((p) => p.team === 'bravo')!;

    freeze(room, bravo.id, { x: 0, y: 31, z: 0 });
    room.deployables.handleDeploy(bravo.id, 'shield', { x: 0, y: 31, z: 0 });
    freeze(room, alpha.id, { x: -40, y: 31, z: 0 });
    const hp0 = bravo.health;

    // Hitscan path goes through dischargeRay — same dome sweep.
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyAlpha = alpha as any;
    bots.arsenal.fireAt(anyAlpha, 'victim', { x: 0, y: 31, z: 0 });
    for (let i = 0; i < 30; i++) { step(room, 1); }
    expect(bravo.health).toBe(hp0);
  });
});
