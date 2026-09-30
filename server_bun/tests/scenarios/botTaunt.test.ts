import { describe, it, expect, beforeEach } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, watch } from './harness.ts';
import { resetTauntCooldowns } from '../../src/botTaunts.ts';

describe('scenario: bot kill taunts', () => {
  beforeEach(() => resetTauntCooldowns());

  it('bot frags eventually produce real chat lines on the wire', () => {
    const room = mkRoom({ mode: 'dm', bots: 2 }, 'dm');
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target] = bots;
    pin(room, shooter!.id, { x: 0, y: 32, z: 0 });
    // Speak chance is a die roll — run a string of frags and expect the
    // wire to carry at least one bot-authored chat line eventually.
    let sawChat = false;
    for (let k = 0; k < 30 && !sawChat; k++) {
      target!.health = 10;
      target!.isDead = false;
      room.projectiles.spawn(shooter!.id, WeaponType.PlasmaGun,
        { x: 0, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      for (let i = 0; i < 300 && w.count('playerKill') < k + 1; i++) {
        pin(room, target!.id, { x: 20, y: 32, z: 0 });
        step(room, 1);
      }
      sawChat = w.msgs.some((m) => m.type === 'chat' && (m as { playerId?: string }).playerId === shooter!.id);
    }
    expect(w.count('playerKill')).toBeGreaterThan(0);
    expect(sawChat).toBe(true);
    const line = w.msgs.find((m) => m.type === 'chat' && (m as { playerId?: string }).playerId === shooter!.id) as { text: string };
    expect(line.text.length).toBeGreaterThan(0);
  });
});
