import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

// A due retarget spends the creature's whole tick — it re-aims and takes
// NO sim step that tick (creatureBrain.stepAll: edge then continue).
// The client replay mirrors this by counting each retarget edge as the
// skipped step; pin the authority side of the contract: on the tick a
// retarget edge fires, the creature's post-tick roster position still
// equals the edge's snapshot.
describe('scenario: retarget edge marks the skipped sim step', () => {
  it('a creature holding position on its retarget tick', () => {
    const room = mkRoom({ creatures: { crawler: 3 }, bots: 1 });
    const w = watch(room);
    for (let i = 0; i < 200; i++) {
      const before = w.count('crawlEvt', 'retarget');
      room.creatureSim.step(0.05);
      const edges = w.msgs.slice(before).filter(
        (m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'retarget',
      );
      for (const e of edges) {
        const id = (e as { id?: number }).id!;
        const pos = (e as { position: { x: number; y: number; z: number } }).position;
        const live = room.creatureSim.roster().find((c) => c.id === id);
        if (!live) continue;
        expect(live.position.x).toBe(pos.x);
        expect(live.position.y).toBe(pos.y);
        expect(live.position.z).toBe(pos.z);
      }
      if (edges.length) return;
    }
    throw new Error('no retarget edge emitted in 200 ticks');
  });

  it('sk is cumulative and non-decreasing across FAR_SKIP gaps', () => {
    // Watchers (and far players) only see every FAR_SKIP-th edge; the
    // sendTo-only retargets in between still consume ticks, so a
    // broadcast edge legitimately jumps sk by >1. The wire contract the
    // replay relies on is: sk never decreases within a creature's life —
    // a reset, wrap, or per-edge recount would corrupt netAcc deltas.
    const room = mkRoom({ creatures: { crawler: 3 }, bots: 1 });
    const w = watch(room);
    const lastSk = new Map<number, number>();
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) {
      room.creatureSim.step(0.05);
      for (const m of w.msgs) {
        if (m.type !== 'crawlEvt') continue;
        const e = m as { id: number; kind: string; sk?: number };
        const prev = lastSk.get(e.id) ?? 0;
        const cur = e.sk ?? 0;
        expect(cur).toBeGreaterThanOrEqual(prev);
        lastSk.set(e.id, cur);
        kinds.add(e.kind);
      }
      w.msgs.length = 0;
    }
    expect(kinds.has('retarget')).toBe(true);
  });
});
