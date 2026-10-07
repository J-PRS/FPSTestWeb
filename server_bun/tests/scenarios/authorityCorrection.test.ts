import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Vec3 } from '../../src/types.ts';

// Authority mode: the move shadow IS the position truth — a divergent
// report earns the client a correction carrying the sim's state.
describe('scenario: move-authority corrections', () => {
  it('a claim past the divergence tolerance gets corrected to sim truth', () => {
    const room = mkRoom({ bots: 1 }, '', 1337, true);
    const p = firstPlayer(room);
    const sent: ServerMessage[] = [];
    room.connections.register(p.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    room.moveSim.track(p.id, p.position, 0, p.perk);

    // First report seeds the shadow (returns null — nothing to judge yet).
    room.messages.handleMessage(p.id, {
      type: 'position', position: { x: 0, y: 31, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, seq: 1, inputSeq: 1,
    } as never);
    expect(sent.filter((m) => m.type === 'correction').length).toBe(0);

    // Deliver the input edge the report is stamped with — uncovered
    // seqs defer while the gap is young (the judge can't replay an
    // input it never received), which would mask the correction this
    // scenario exists to exercise.
    room.moveSim.setInput(p.id, { forward: 0 }, 0, 2);
    // Second report claims 5m the sim never walked — past the 1.5m
    // authority tolerance, inside plausibility bounds (<50m jump, <300m/s).
    room.messages.handleMessage(p.id, {
      type: 'position', position: { x: 5, y: 31, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, seq: 2, inputSeq: 2,
    } as never);
    const corr = sent.filter((m) => m.type === 'correction');
    expect(corr.length).toBe(1);
    const c = corr[0] as { position: Vec3; inputSeq: number };
    expect(c.position.x).toBeCloseTo(0, 5); // corrected to where the sim says they are
    expect(c.inputSeq).toBeDefined(); // replay anchor for the client's rollback
  });

  it('a stale-epoch report (pre-respawn replay) is not judged', () => {
    const room = mkRoom({ bots: 1 }, '', 1337, true);
    const p = firstPlayer(room);
    const sent: ServerMessage[] = [];
    room.connections.register(p.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.messages.handleMessage(p.id, {
      type: 'position', position: { x: 0, y: 31, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, seq: 1, inputSeq: 1,
    } as never);
    // A report stamped at/before the resync epoch — the client's old
    // position from before the snap — must not flag a phantom blow-through.
    // Small enough to pass the plausibility gate (<50m jump, <300m/s) so
    // ONLY the epoch check is exercising here.
    room.messages.handleMessage(p.id, {
      type: 'position', position: { x: 8, y: 31, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, seq: 2, inputSeq: 0,
    } as never);
    expect(sent.filter((m) => m.type === 'correction').length).toBe(0);
  });
});
