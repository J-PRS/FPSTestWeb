import { describe, it, expect } from 'bun:test';
import { mkRoom, flat } from './harness.ts';
import { hmHeight } from '../../../shared/heightfield.ts';

// Spawn anchors are authored data that can predate the terrain — a buried
// point must lift to the heightfield surface, not spawn a player into the
// ground (observed live: a bot materialized at y=8 under 27.5m terrain).
describe('scenario: spawn lifts to terrain', () => {
  it('an anchor below the field spawns at the surface', () => {
    const room = mkRoom({ bots: 0, spawns: [{ x: 0, y: 0, z: 0 }] });
    const p = room.players.addPlayer('t-human', undefined, 'none', 'medium');
    expect(p.position.y).toBe(hmHeight(flat, 0, 0));
  });

  it('an anchor above the field keeps its authored y', () => {
    const room = mkRoom({ bots: 0, spawns: [{ x: 0, y: 100, z: 0 }] });
    const p = room.players.addPlayer('t-human', undefined, 'none', 'medium');
    expect(p.position.y).toBe(100);
  });
});
