import { describe, expect, it } from 'bun:test';
import { mkRoom, firstPlayer, pin, replica, step } from './harness.ts';

// Headless StateHash parity — the live client's DESYNC warn compares its
// replica against the server's broadcast hash; a browser was the only place
// that check ran, so drift classes (stale health, dead rosters, liveness
// edges) were only ever caught in production consoles. The replica eats the
// room's real wire output (wireIds + binary tick frames), so parity asserts
// here mean the wire actually converges.

const assertParity = (r: ReturnType<typeof replica>) => {
  const d = r.diff();
  expect(d, `replica drift: ${d.join('; ')}`).toEqual([]);
  expect(r.hash()).toBe(r.roomHash());
};

describe('scenario: wire replica stays in parity with room truth', () => {
  it('a busy room streams every hashed field to parity', () => {
    const room = mkRoom({ mode: 'ctf', bots: 6,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } } }, 'ctf');
    // pin clears spawn protection — applyDamage respects protectedUntil
    // and a shielded bot reads as a damage assert failing, not parity.
    for (const p of room.players.getAllPlayers().values()) pin(room, p.id, p.position);
    const r = replica(room);
    try {
      step(room, 20); // join records + wireIds land
      assertParity(r);
      // Damage one bot — health is the 'echo' channel: the record must
      // carry the new hp through or the replica hashes a stale bucket.
      const p = firstPlayer(room);
      const hpBefore = p.health;
      room.players.applyDamage(p.id, 30);
      expect(p.health).toBeLessThan(hpBefore);
      step(room, 4);
      assertParity(r);
      // Kill + respawn — isDead is the 'edge' channel: a missed flip is
      // the zombie-ghost class, exact-match in the hash.
      room.players.applyDamage(p.id, 500);
      step(room, 4);
      assertParity(r);
      p.isDead = false; p.health = p.maxHealth; // respawn
      step(room, 4);
      assertParity(r);
      // Move — positions are the 'sim' channel at 1m granularity.
      pin(room, p.id, { x: p.position.x + 40, y: p.position.y, z: p.position.z });
      step(room, 4);
      assertParity(r);
      // Removal — playerLeft must evict, or the replica holds a ghost
      // the server's hash doesn't count.
      room.removePlayerCompletely(p.id, 'test', () => {});
      step(room, 4);
      assertParity(r);
    } finally {
      r.detach();
    }
  });

  it('records keep flowing under suppression churn', () => {
    // Suppressed records (sub-0.3m extrapolated drift) are legal — the
    // replica keeps its last sample, which the 1m-rounded hash tolerates.
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    // Humans earn records only after their first position report —
    // production clients reach parity on unreported ids via the join
    // snapshot, a channel the replica doesn't model. Stamping the flag
    // is the honest way to say "these clients have moved".
    for (const id of ['p1', 'p2']) {
      const p = room.players.getPlayer(id)!;
      p.hasReceivedPosition = true;
    }
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    pin(room, 'p2', { x: 30, y: 31, z: 0 });
    const r = replica(room);
    try {
      step(room, 10);
      assertParity(r);
      // Micro-jitter inside the suppression band, then a real move —
      // parity must survive the suppressed gaps.
      const p = firstPlayer(room);
      for (let i = 0; i < 8; i++) {
        p.position.x += 0.05;
        step(room, 1);
      }
      assertParity(r);
      pin(room, p.id, { x: p.position.x + 60, y: p.position.y, z: p.position.z });
      step(room, 4);
      assertParity(r);
    } finally {
      r.detach();
    }
  });
});
