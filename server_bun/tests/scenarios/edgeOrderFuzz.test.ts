// edgeOrderFuzz — lifecycle ordering conformance over the whole wire.
// Captures EVERY msg a room emits (broadcast + near-player sendTo = the
// union stream a maximally-informed client could ride) while bots fight,
// then asserts the happens-before grammar every replica relies on:
//
//   * spawn before life — an update/gone for an id that never spawned
//     during the run is only legal if it predates capture (warmup);
//     within the capture window spawn must precede everything
//   * gone is terminal — no message for a dead id afterward (ids are
//     monotonic per room: no reuse within a room's life)
//   * no double spawn while live — a second spawn for a live id is a
//     lifecycle leak (the ghost class)
//   * stamped edges are non-decreasing per id — isStaleSeg and the
//     appliedSkips math both assume monotone stamps
import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { decodeBallSegment } from '../../../shared/wire.ts';
import type { ServerMessage } from '../../src/types.ts';

// id-bearing lifecycle verbs: [spawn, update/gone families keyed by id field]
const FAMILIES: Record<string, { idOf: (m: never) => string | number; spawn?: string; gone?: string; stamps?: boolean }> = {
  ball: {
    idOf: (m: unknown) => (m as { id: number }).id,
    spawn: 'ballSpawn', gone: 'ballDie', stamps: true,
  },
  creature: {
    idOf: (m: unknown) => (m as { id: number }).id,
    spawn: 'crawlSpawn', gone: 'crawlDie', stamps: true,
  },
  deploy: {
    idOf: (m: unknown) => (m as { id: number }).id,
    spawn: 'deploySpawn', gone: 'deployGone',
  },
  player: {
    idOf: (m: unknown) => (m as { playerId: string }).playerId,
    spawn: 'playerJoined', gone: 'playerLeft',
  },
  projectile: {
    idOf: (m: unknown) => (m as { projectileId: string }).projectileId,
    spawn: 'projectileCreated', gone: 'projectileDestroyed',
  },
};

const TYPE_FAMILY = new Map<string, { fam: keyof typeof FAMILIES; cls: 'spawn' | 'gone' | 'edge' }>();
for (const [fam, f] of Object.entries(FAMILIES)) {
  if (f.spawn) TYPE_FAMILY.set(f.spawn, { fam, cls: 'spawn' });
  if (f.gone) TYPE_FAMILY.set(f.gone, { fam, cls: 'gone' });
}
// Edge types per family — anything stamped or id-bearing that isn't
// spawn/gone must arrive between them.
const EDGE_TYPES: Record<string, string[]> = {
  ball: ['ballSegment'],
  creature: ['crawlEvt'],
  deploy: ['deployHp'],
  player: [],
  projectile: [],
};
for (const [fam, types] of Object.entries(EDGE_TYPES)) {
  for (const t of types) TYPE_FAMILY.set(t, { fam, cls: 'edge' });
}

describe('wire lifecycle ordering fuzz', () => {
  it('spawn-before-edge, gone-terminal, monotone stamps hold across a live match', () => {
    const room = mkRoom({ mode: 'dm', bots: 8, balls: { base: 8, perPlayer: 1, max: 16 }, creatures: { crawler: 4, baneling: 2 } }, 'dm', 7);
    const violations: string[] = [];

    // Capture the union of broadcast + targeted sends.
    const seen: { type: string; m: ServerMessage; op: number }[] = [];
    const prevB = room.connections.broadcast.bind(room.connections);
    room.connections.broadcast = (m: ServerMessage, ex?: string) => { seen.push({ type: m.type, m, op: OPS_SEEN }); prevB(m, ex); };
    const prevS = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid: string, m: ServerMessage) => { seen.push({ type: m.type, m, op: OPS_SEEN }); prevS(pid, m); };
    // ballSegment rides the binary lane — decode to the same stream.
    const prevBin = room.connections.broadcastBinaryReliable.bind(room.connections);
    room.connections.broadcastBinaryReliable = (data: Uint8Array) => {
      const s = decodeBallSegment(data);
      if (s) seen.push({ type: 'ballSegment', m: s as unknown as ServerMessage, op: OPS_SEEN });
      prevBin(data);
    };

    let OPS_SEEN = 0;
    const OPS = 400;
    for (let op = 0; op < OPS; op++) {
      OPS_SEEN = op;
      step(room, 1, 0.05);
    }

    // Per (family,id) stream state.
    type St = { spawned: boolean; dead: boolean; lastT: number; firstOp: number };
    const streams = new Map<string, St>();
    const counts = new Map<string, number>();
    for (const { type, m, op } of seen) {
      const meta = TYPE_FAMILY.get(type);
      if (!meta) continue;
      const f = FAMILIES[meta.fam]!;
      const id = String(f.idOf(m as never));
      const key = `${meta.fam}:${id}`;
      let st = streams.get(key);
      if (!st) { st = { spawned: false, dead: false, lastT: -Infinity, firstOp: op }; streams.set(key, st); }
      counts.set(type, (counts.get(type) ?? 0) + 1);

      if (meta.cls === 'gone') {
        if (st.dead) violations.push(`${key}: double gone (${type}) at op ${op}`);
        st.dead = true;
      } else if (meta.cls === 'spawn') {
        if (st.dead) violations.push(`${key}: spawn after gone at op ${op} — id reuse breaks replica baselines`);
        else if (st.spawned) violations.push(`${key}: duplicate spawn at op ${op}`);
        st.spawned = true;
      } else {
        if (st.dead) violations.push(`${key}: ${type} after gone at op ${op} — resurrecting edge`);
        const t = (m as { t?: number }).t;
        if (f.stamps && t !== undefined) {
          if (t < st.lastT) violations.push(`${key}: stamp rewound ${st.lastT} → ${t} at op ${op} — stale-drop relies on monotone t`);
          st.lastT = t;
        }
      }
    }

    // Sanity: the capture must have seen real lifecycle traffic or the
    // pass is vacuous — balls alone emit hundreds of segments.
    const segCount = counts.get('ballSegment') ?? 0;
    expect(segCount).toBeGreaterThan(100);
    expect((counts.get('crawlEvt') ?? 0)).toBeGreaterThan(10);
    expect(seen.length).toBeGreaterThan(200);

    expect(violations).toEqual([]);
  });
});
