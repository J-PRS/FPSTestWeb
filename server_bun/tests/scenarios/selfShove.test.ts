import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

// Disc-jump physics: a bot's own blast shoves its shadow (bot velocity is
// server truth) while a human's own blast still doesn't touch them —
// judge-mode clients self-predict displacement and would double-apply it.
describe('scenario: self blast shove', () => {
  it('a bot at its own blast edge gains velocity away from the center', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const bot = [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
    pin(room, bot.id, { x: 0, y: 31, z: 0 });
    const before = { ...room.moveSim.simPos(bot.id)! };

    // Blast 2m behind the bot — push impulse should carry it forward (+z) and up.
    room.messages.serverBlast(bot.id, { x: 0, y: 30, z: -2 }, WeaponType.Rocket, null);
    step(room, 20);
    const after = room.moveSim.simPos(bot.id)!;
    expect(after.z - before.z).toBeGreaterThan(0.5);
    expect(after.y).toBeGreaterThan(before.y);
  });

  it('a human at their own blast edge is NOT shoved', () => {
    const room = mkRoom({ bots: 0 }, 'dm');
    const h = room.players.addPlayer('t-human', undefined, 'none', 'medium');
    h.position = { x: 0, y: 31, z: 0 };
    const v0 = { ...h.velocity };
    room.messages.serverBlast(h.id, { x: 0, y: 30, z: -2 }, WeaponType.Rocket, null);
    expect(h.velocity).toEqual(v0);
  });
});
