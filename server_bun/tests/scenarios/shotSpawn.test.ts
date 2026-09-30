import { describe, it, expect } from 'bun:test';
import { mkRoom, twoPlayers, freeze, watch } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// The spawn-report contract real clients (and wire bots) depend on:
// `shot{targetId:null, position, velocity}` near the shooter registers a
// tracked shell and broadcasts its server id to observers — that's the
// id every later hit/aoe claim must echo.
describe('scenario: projectile spawn reports', () => {
  it('a sane spawn report registers a projectile and broadcasts its id', () => {
    const room = mkRoom({ bots: 2 });
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    const w = watch(room);

    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null, weaponType: 0,
      position: { x: 0, y: 61.6, z: 0 }, velocity: { x: 90, y: 0, z: 0 },
    } as never);

    const created = w.msgs.filter((m) => m.type === 'projectileCreated') as Extract<ServerMessage, { type: 'projectileCreated' }>[];
    expect(created.length).toBe(1);
    expect(created[0]!.projectileId).toMatch(/^proj_/);
    expect(created[0]!.ownerId).toBe(a.id);
    expect(created[0]!.velocity.x).toBe(90);
  });

  it('rejects spawn reports from nowhere near the shooter', () => {
    const room = mkRoom({ bots: 2 });
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    const w = watch(room);

    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null, weaponType: 0,
      position: { x: 200, y: 60, z: 0 }, velocity: { x: 90, y: 0, z: 0 },
    } as never);

    expect(w.count('projectileCreated')).toBe(0);
  });

  it('rejects spawn reports past the launch-speed cap', () => {
    const room = mkRoom({ bots: 2 });
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    const w = watch(room);

    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null, weaponType: 0,
      position: { x: 0, y: 61.6, z: 0 }, velocity: { x: 900, y: 0, z: 0 },
    } as never);

    expect(w.count('projectileCreated')).toBe(0);
  });

  it('spawn-then-claim: the echoed id authorizes the hit', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    freeze(room, b.id, { x: 45, y: 60, z: 0 });
    const w = watch(room);

    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null, weaponType: 0,
      position: { x: 0, y: 61.6, z: 0 }, velocity: { x: 90, y: 0, z: 0 },
    } as never);
    const created = w.msgs.filter((m) => m.type === 'projectileCreated') as Extract<ServerMessage, { type: 'projectileCreated' }>[];
    const pid = created[0]!.projectileId;

    // Claim at the target's position after a 0.5s flight — no rejection.
    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: b.id, weaponType: 0, projectileId: pid,
      position: { x: 45, y: 61.6, z: 0 }, airtime: 0.5,
    } as never);

    expect(w.count('shotRejected')).toBe(0);
    expect(w.count('playerHit')).toBe(1);
  });
});
