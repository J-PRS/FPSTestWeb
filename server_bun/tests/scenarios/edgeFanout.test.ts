import { describe, it, expect } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, step, freeze, watch, twoPlayers } from './harness.ts';
import { STATUS } from '../../../shared/status.ts';

describe('scenario: distance-tiered edge fanout', () => {
  it('near players get every edge; far players only see the 4th-edge broadcast', () => {
    // One crawler only: spawns anchor on any uncloaked player, so a second
    // crawler could legitimately sit next to the "far" player — its edges
    // would rightly sendTo them. One source makes far provably far.
    const room = mkRoom({ creatures: { crawler: 1 }, bots: 2 });
    const w = watch(room);
    const [near, far] = twoPlayers(room);
    // Both frozen — brains must not wander or cloak (a cloaked near player
    // isn't an aggro target at all).
    freeze(room, near.id, { x: 0, y: 31, z: 0 });
    freeze(room, far.id, { x: 600, y: 31, z: 600 });
    // Cloak the far player — crawlers ignore cloaked targets, so it can
    // never CHASE them into the near tier (frozen brains keep manual bits).
    room.players.getPlayer(far.id)!.status = STATUS.CLOAK;
    // Spawn anchors on uncloaked players — crawlers appear near one of them.
    step(room, 40);
    const crawlers = room.creatureSim.roster();
    expect(crawlers.length).toBe(1);
    // Park the near player beside a crawler so it keeps committing attacks.
    const c = crawlers[0]!;
    freeze(room, near.id, { x: c.position.x + 8, y: 31, z: c.position.z });
    const toNear: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === near.id) toNear.push(m); else orig(pid, m); };
    w.msgs.length = 0;
    step(room, 120);
    const edges = toNear.filter((m) => m.type === 'crawlEvt').length;
    const bcast = w.count('crawlEvt');
    // Near rides ~3 sendTo per 1 broadcast resync — the ratio must clearly
    // favor per-player sends, and the far player must never get one.
    expect(edges).toBeGreaterThan(bcast);
    expect(bcast).toBeGreaterThan(0);
    // Spectator-side check: nothing was addressed to the far player.
    let farSends = 0;
    room.connections.sendToPlayer = (pid) => { if (pid === far.id) farSends++; };
    step(room, 40);
    expect(farSends).toBe(0);
  });
});
