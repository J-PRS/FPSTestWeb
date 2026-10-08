import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';

vi.mock('../core/sfx.js', () => ({ at: () => {}, shotAt: () => {}, init: () => {}, hitMarker: () => {}, playerHurt: () => {}, shieldHit: () => {}, killConfirm: () => {}, flagCue: () => {}, matchHorn: () => {} }));
vi.mock('../entities/PlayerModel.js', () => ({
  PlayerModel: function () {
    return new Proxy({ load: () => Promise.resolve() }, {
      get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => {}),
    });
  },
}));
globalThis.fetch = () => new Promise<Response>(() => {});

import { makeDeps, feed } from './netHarness.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';

// Real dispose runs full aura/anim/model teardown — outside this invariant's
// scope and unavailable in jsdom; stub it.
vi.spyOn(RemotePlayer.prototype, 'dispose').mockImplementation(() => {});

// Client-side roster conformance fuzz: a seeded op stream drives the real
// dispatch (gameState replaces, playerJoined mints, playerLeft removes,
// tickUpdate mints+materializes, respawn revives). Model truth is a plain
// set; every op asserts client == model, then a clean window re-checks.

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

const GS = (ids: string[]) => ({
  type: 'gameState', players: ids.map((id) => ({
    id, internalId: id.toLowerCase(), position: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 100, isDead: false,
  })),
  protocolVersion: PROTOCOL_VERSION, room: 'rfz',
} as ServerMessage);

describe('rosterFuzz — client roster conformance', () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => { h = makeDeps(); });

  for (const seed of [11, 22, 33, 44, 55]) {
    it(`seed ${seed}: membership tracks model through chaos`, () => {
      const rnd = lcg(seed);
      const opsSeen = new Set<string>();
      feed(h.nm, GS([]));
      // members: ids the client should hold. tickSeen: ids that got ≥1
      // tick record (entity materializes on first tick, not on join).
      const members = new Set<string>();
      const tickSeen = new Set<string>();
      const dead = new Set<string>();
      const ids = () => [...members];
      const freshId = () => `peer-${Math.floor(rnd() * 12)}`;
      const tickRow = (id: string) => ({
        playerId: id, position: { x: rnd() * 100, y: 0, z: rnd() * 100 },
        rotation: { yaw: rnd() * 6, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
        health: Math.floor(rnd() * 100), isDead: rnd() < 0.2,
      });
      const assertTruth = (op: string) => {
        const client = [...h.nm.getPlayers().keys()].filter((k) => k !== 'tester-local').sort();
        const want = ids().sort();
        expect(client, `membership after ${op}`).toEqual(want);
        // Entity ⊆ members, and only tick-seen members materialize.
        for (const [id] of h.world.remotePlayers) {
          expect(members.has(id), `entity ${id} of non-member after ${op}`).toBe(true);
          expect(tickSeen.has(id), `entity ${id} without tick after ${op}`).toBe(true);
        }
      };

      for (let op = 0; op < 120; op++) {
        const roll = rnd();
        const tag = `op${op}(r${roll.toFixed(2)})`;
        if (roll < 0.25) { // joined (fresh or rejoin)
          const id = freshId();
          members.add(id); opsSeen.add('join');
          feed(h.nm, { type: 'playerJoined', playerId: id, position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
        } else if (roll < 0.45) { // left
          const id = ids()[Math.floor(rnd() * ids().length)] ?? freshId();
          members.delete(id); tickSeen.delete(id); dead.delete(id); opsSeen.add('left');
          feed(h.nm, { type: 'playerLeft', playerId: id } as ServerMessage);
        } else if (roll < 0.8) { // tick batch over random subset + a ghost
          const sub = ids().filter(() => rnd() < 0.6);
          const rows = sub.map(tickRow);
          // An isDead row mints the roster row but never the body —
          // onPlayerUpdate waits for a respawn edge (players.ts).
          for (let i = 0; i < sub.length; i++) { if (!rows[i]!.isDead) tickSeen.add(sub[i]!); }
          const ghost = rnd() < 0.15 ? 'ghost-' + Math.floor(rnd() * 4) : null;
          let ghostRow: ReturnType<typeof tickRow> | null = null;
          if (ghost) { members.add(ghost); ghostRow = tickRow(ghost); if (!ghostRow.isDead) tickSeen.add(ghost); } // a record for an unseen id mints membership (upsert owns create)
          feed(h.nm, { type: 'tickUpdate', updates: [...rows, ...(ghostRow ? [ghostRow] : [])] } as ServerMessage);
          opsSeen.add('tick'); if (ghostRow) {opsSeen.add('ghost');}
        } else if (roll < 0.9) { // respawn
          const id = ids()[Math.floor(rnd() * ids().length)] ?? freshId();
          if (!members.has(id)) { members.add(id); }
          opsSeen.add('respawn');
          tickSeen.add(id); // respawn materializes the entity too (ctx.ts: respawn-into-missing)
          dead.delete(id);
          feed(h.nm, { type: 'playerRespawn', playerId: id, position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
          expect(h.nm.getPlayers().get(id)!.isDead, `respawn must revive ${tag}`).toBe(false);
          expect(h.nm.getPlayers().get(id)!.health, `respawn must reset hp ${tag}`).toBe(100);
        } else { // gameState replace — the room hop: membership resets wholesale
          const keep = freshId();
          // An id carried into the new roster keeps its entity — the
          // hop reseats it, it isn't recreated.
          const carried = tickSeen.has(keep);
          members.clear(); tickSeen.clear(); dead.clear();
          members.add(keep);
          if (carried) tickSeen.add(keep);
          opsSeen.add('gs');
          feed(h.nm, GS([keep]));
        }
        assertTruth(tag);
      }
      // Non-vacuous: every op family must have actually fired.
      for (const k of ['join', 'left', 'tick', 'respawn', 'gs']) {expect(opsSeen.has(k), `op ${k} never fired`).toBe(true);}
    });
  }
});
