import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, freeze, watch, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

describe('scenario: tdm kill-confirmation', () => {
  it('a kill drops a tag at the corpse; grabbing it banks the point', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const [killer, target] = twoPlayers(room);
    killer.team = 'alpha'; target.team = 'bravo';
    pin(room, killer.id, { x: 0, y: 31, z: 0 });
    freeze(room, target.id, { x: 20, y: 31, z: 0 });
    // applyDamage alone bypasses onKill (score/tag live in CombatHandler's
    // applyHit) — the kill must come through the real projectile funnel.
    target.health = 1; target.armor = 0;
    room.projectiles.spawn(killer.id, WeaponType.PlasmaGun,
      { x: 0, y: 31, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 100 && !target.isDead; i++) {
      freeze(room, target.id, { x: 20, y: 31, z: 0 });
      step(room, 1);
    }
    expect(target.isDead).toBe(true);
    // Kill itself scores one point; the corpse tag is the second point
    // any team can grab — deny by reaching it first.
    expect(room.scores.alpha).toBe(1);
    const tag = w.msgs.find((m) => m.type === 'pickupSpawn'
      && (m as { kind: string }).kind === 'tag') as { pos: { x: number; z: number; y: number } } | undefined;
    expect(tag).toBeTruthy();
    expect(Math.hypot(tag!.pos.x - 20, tag!.pos.z)).toBeLessThan(3);
    // The killer walks the tag — confirmation, not the kill, is the point.
    pin(room, killer.id, { x: tag!.pos.x, y: tag!.pos.y, z: tag!.pos.z });
    step(room, 5);
    expect(room.scores.alpha).toBe(2);
  });
});
