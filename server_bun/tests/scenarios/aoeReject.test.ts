import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: aoeShot validation', () => {
  it('a blast claim naming no real projectile is refused — no splash, no damage', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };
    const hpBefore = room.players.getPlayer(b.id)!.health;

    // A never fired — but claims a rocket detonated right at B's feet.
    // This authority sims every outcome, so the claim is refused at the
    // gate — the stamp comes back as a refused ack, never a blast.
    const forged = {
      type: 'aoeShot',
      position: { x: 30, y: 31, z: 0 },
      weaponType: WeaponType.BoltLauncher,
      projectileId: null,
      airtime: 0.5,
      claimSeq: 3,
    } as Extract<ClientMessage, { type: 'aoeShot' }>;
    for (let i = 0; i < 6; i++) room.messages.handleMessage(a.id, forged);
    step(room, 5);
    expect(w.count('playerHit')).toBe(0);
    expect(room.players.getPlayer(b.id)!.health).toBe(hpBefore);
    expect(toA.some((m) => m.type === 'claimAck' && (m as { ok?: boolean }).ok === false)).toBe(true);
  });
});
