import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {wireStateDebug, type StateDebugContext} from '../core/stateDebug.js';
import { NetworkManager } from '../networking/NetworkManager.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Player } from '../entities/Player.js';
import type { SnapshotPlayer } from '../../../shared/protocol.js';

// Heal-loop conformance fuzz: the warn→request→snapshot→heal cycle is the
// roster's last-line recovery. Deterministic tests pin each primitive; this
// drives the WHOLE loop under seeded chaos (roster churn, health/liveness
// drift, lost + reordered snapshot replies, cooldown timing) and asserts the
// invariant: after every snapshot reply the client roster converges to
// server truth — membership, health, liveness — with no ghosts.
// Everything funnels through the real wireStateDebug path.

function mulberry(seed: number) {
  return () => {
    // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point
    seed |= 0; seed = (seed + 0x6D_2B_79_F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const log = { debug: () => { return; }, info: () => { return; }, warn: () => { return; }, error: () => { return; } };

interface ServerP { id: string; x: number; y: number; z: number; health: number; isDead: boolean }

function mk(localHealth = 100) {
  const nm = new NetworkManager();
  const remotePlayers = new Map<string, RemotePlayer>();
  const localPlayer = { health: localHealth, isDead: false } as unknown as Player;
  const ctx: StateDebugContext = {
    networkManager: nm,
    getPlayer: () => localPlayer,
    remotePlayers: remotePlayers as StateDebugContext['remotePlayers'],
    projectiles: [],
    getLastSentPos: () => ({ x: 0, y: 0, z: 0 }),
    world: { mode: 'test' },
    logger: log as unknown as StateDebugContext['logger'],
  };
  wireStateDebug(ctx);
  (remotePlayers as StateDebugContext['remotePlayers']).remove = (id: string) => remotePlayers.delete(id);
  return { nm, ctx, remotePlayers, localPlayer };
}

function snap(p: ServerP): SnapshotPlayer {
  return {
    id: p.id, internalId: 0, position: { x: p.x, y: p.y, z: p.z },
    rotation: 0, velocity: { x: 0, y: 0, z: 0 }, health: p.health,
    isDead: p.isDead, kills: 0, deaths: 0,
  } as unknown as SnapshotPlayer;
}

describe('stateDebug heal-loop conformance fuzz', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (const seed of [7, 42, 1337, 20_240, 999_983]) {
    it(`seed ${seed}: roster converges to server truth under churn`, () => {
      const rnd = mulberry(seed);
      const { nm, ctx, remotePlayers, localPlayer } = mk();
      const server = new Map<string, ServerP>();
      // Pending snapshot replies ride a queue that can be dropped/reordered —
      // exactly what a WAN does to the request→reply pair.
      const replyQueue: SnapshotPlayer[][] = [];

      const fireCheck = () => {
        // 'zz' can never equal the computed FNV — every call is a mismatch,
        // so every pending reply heals. Server id must always include the
        // local player (real snapshots do).
        nm.onStateHash?.('zz', 1, server.size + 1, Date.now());
        replyQueue.push([...server.values(), {
          id: nm.getLocalPlayerId(), x: 0, y: 0, z: 0,
          health: localPlayer.health, isDead: false,
        }].map(snap));
      };
      const deliver = () => {
        const batch = replyQueue.shift();
        if (batch) {nm.onSnapshot?.(batch, Date.now());}
      };

      for (let op = 0; op < 150; op += 1) {
        const roll = rnd();
        const ids = [...server.keys()];
        if (roll < 0.3 || ids.length === 0) {
          // Server joins a new player.
          const id = `srv-${Math.floor(rnd() * 1e6)}`;
          server.set(id, { id, x: rnd() * 100, y: rnd() * 50, z: rnd() * 100, health: Math.floor(rnd() * 101), isDead: rnd() < 0.1 });
        } else if (roll < 0.5) {
          // Server drops a player — lost playerLeft.
          server.delete(ids[Math.floor(rnd() * ids.length)]!);
        } else if (roll < 0.7) {
          // Server mutates: combat drift / liveness flip.
          const p = server.get(ids[Math.floor(rnd() * ids.length)]!)!;
          p.health = Math.floor(rnd() * 101);
          if (rnd() < 0.3) {p.isDead = !p.isDead;}
          p.x += rnd() * 10 - 5; p.z += rnd() * 10 - 5;
        } else if (roll < 0.85) {
          // Client-side divergence lands with no edge: partial roster,
          // stale health, ghost member.
          const act = rnd();
          const clientIds = [...nm.getPlayers().keys()].filter(id => id !== nm.getLocalPlayerId());
          if (act < 0.35 && ids.length > 0) {
            const miss = ids[Math.floor(rnd() * ids.length)]!;
            nm.getPlayers().delete(miss); // join edge never arrived
          } else if (act < 0.7 && clientIds.length > 0) {
            const cid = clientIds[Math.floor(rnd() * clientIds.length)]!;
            const cp = nm.getPlayers().get(cid)!;
            cp.health = Math.max(0, cp.health - Math.floor(rnd() * 40) - 5);
          } else {
            const ghost = `ghost-${Math.floor(rnd() * 1e6)}`;
            nm.upsertRemotePlayer(ghost, { position: { x: 1, y: 1, z: 1 }, health: 50, isDead: false });
            remotePlayers.set(ghost, {} as RemotePlayer);
          }
        } else if (roll < 0.95) {
          fireCheck();
          if (rnd() < 0.25) {replyQueue.length = 0;} // reply lost on the wire
          if (rnd() < 0.9) {deliver();}
          else if (replyQueue.length > 1) { // reorder: later reply lands first
            const last = replyQueue.pop()!;
            nm.onSnapshot?.(last, Date.now());
          }
        }
        // Cooldown breathing — the 5s gate is part of the loop under test.
        vi.advanceTimersByTime(Math.floor(rnd() * 6000));
      }

      // Clean window: mismatch → reply → heal, until stable.
      for (let i = 0; i < 6; i += 1) {
        vi.advanceTimersByTime(6000);
        fireCheck(); deliver();
        replyQueue.length = 0;
      }

      for (const [id, sp] of server) {
        const cp = nm.getPlayers().get(id);
        expect(cp, `missing member ${id} never healed`).toBeTruthy();
        expect(cp!.health, `health divergent for ${id}`).toBe(sp.health);
        expect(cp!.isDead, `liveness divergent for ${id}`).toBe(sp.isDead);
      }
      for (const id of nm.getPlayers().keys()) {
        if (id === nm.getLocalPlayerId()) {continue;}
        expect(server.has(id), `ghost ${id} never retired`).toBe(true);
        expect(remotePlayers.has(id), `ghost entity ${id} never removed`).toBe(false);
      }
    });
  }
});
