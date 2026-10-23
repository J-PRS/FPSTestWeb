import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';
import { decodeBallAny } from '../../../shared/wire.ts';

// A due retarget spends the ball's whole tick — stepAll emits the
// 'bounce' segment then `continue`s, taking NO stepBall step that tick.
// Unlike creatures (whose retarget edge is a marker the replay counts),
// the ball's segment IS the anchor: it must carry the post-skip state —
// the roster position at end of tick — or every client's replay anchors
// one step ahead of authority on each retarget (§2.38's rubberband
// class). Pin: on any emitted segment, position equals post-step
// roster truth.
describe('scenario: ball segment anchor equals post-tick state', () => {
  it('a segment emitted mid-tick carries the unstepped position', () => {
    const room = mkRoom({ mode: 'dm', bots: 3, balls: { base: 4, perPlayer: 0, max: 4 } }, 'dm', 42);
    const segs: { id: number; kind: string; x: number; y: number; z: number }[] = [];
    const prev = room.connections.broadcastBinaryReliable.bind(room.connections);
    room.connections.broadcastBinaryReliable = (data: Uint8Array) => {
      for (const s of decodeBallAny(data)) {segs.push({ id: s.id, kind: s.kind, x: s.position.x, y: s.position.y, z: s.position.z });}
      prev(data);
    };
    let sawBounce = false;
    for (let i = 0; i < 400; i++) {
      const before = segs.length;
      room.ballSim.step(0.05);
      for (const s of segs.slice(before)) {
        const live = room.ballSim.roster().find((b) => b.id === s.id);
        if (!live) continue;
        expect(live.position.x).toBeCloseTo(s.x, 4);
        expect(live.position.y).toBeCloseTo(s.y, 4);
        expect(live.position.z).toBeCloseTo(s.z, 4);
        if (s.kind === 'bounce') sawBounce = true;
      }
    }
    expect(sawBounce).toBe(true); // retarget path actually exercised
  });
});
