import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';

const HH_SPEC = resolveMapSpec({ mode: 'headhunt' });

function addAt(room: Room, id: string, team: 'alpha' | 'bravo' | undefined, x: number, z = 0) {
  const p = room.players.addPlayer(id, team);
  p.position = { x, y: 0, z };
  return p;
}

describe('Headhunt', () => {
  it('token grab increments held and the live team score', () => {
    const room = new Room('h', null, '', HH_SPEC);
    const p = addAt(room, 'p1', 'alpha', 10, 0);
    room.pickups!.spawn({ x: 10, y: 0, z: 0 }, 'token');
    room.pickups!.tick(0.05);
    expect(p.heldTokens).toBe(1);
    expect(room.scores.alpha).toBe(1);
    expect(room.scores.bravo).toBe(0);
    expect(room.pickups!.snapshot().length).toBe(0);
  });

  it('death scatters held + 1 in denominations and zeroes the carrier', () => {
    const room = new Room('h', null, '', HH_SPEC);
    const p = addAt(room, 'p1', 'alpha', 10, 0);
    p.heldTokens = 10;
    room.scoring.syncHeld();
    expect(room.scores.alpha).toBe(10);
    room.scoring.onKill('p1', 'p2');
    expect(p.heldTokens).toBe(0);
    expect(room.scores.alpha).toBe(0);
    const snaps = room.pickups!.snapshot();
    // 10 held + 1 corpse bounty = 11 → one blue(9) + two whites(1+1).
    expect(snaps.map((s): number => s.val).sort()).toEqual([1, 1, 9]);
    for (const s of snaps) {expect(s.kind).toBe('token');}
  });

  it('a leaver scatters held tokens where they stood, denominated', () => {
    const room = new Room('h', null, '', HH_SPEC);
    const p = addAt(room, 'p1', 'alpha', 10, 0);
    p.heldTokens = 13;
    room.scoring.syncHeld();
    room.removePlayerCompletely('p1', 'test', (): void => {});
    const snaps = room.pickups!.snapshot();
    // Leavers forfeit the bounty — exact held only: 13 → 9+3+1.
    expect(snaps.map((s): number => s.val).sort()).toEqual([1, 3, 9]);
    expect(room.scores.alpha).toBe(0);
  });

  it('a high-value coin banks its full denomination on grab', () => {
    const room = new Room('h', null, '', HH_SPEC);
    const p = addAt(room, 'p1', 'alpha', 10, 0);
    room.pickups!.spawn({ x: 10, y: 0, z: 0 }, 'token', 0, 9);
    room.pickups!.tick(0.05);
    expect(p.heldTokens).toBe(9);
    expect(room.scores.alpha).toBe(9);
  });

  it('a teamless player cannot collect tokens', () => {
    const room = new Room('h', null, '', HH_SPEC);
    addAt(room, 'ghost', undefined, 10, 0);
    room.pickups!.spawn({ x: 10, y: 0, z: 0 }, 'token');
    room.pickups!.tick(0.05);
    expect(room.pickups!.snapshot().length).toBe(1);
  });

  it('creature kills in headhunt drop tokens, not gems', () => {
    const room = new Room('h', null, '', HH_SPEC);
    addAt(room, 'hunter', 'alpha', 10, 0);
    room.ballSim.onKilled!('hunter', { x: 10, y: 0, z: 0 }, 0);
    const snaps = room.pickups!.snapshot();
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    // Score drops are tokens — a rolled powerup may sit alongside them.
    const scoreKinds = snaps.filter((s): boolean => s.kind === 'token' || s.kind === 'gem' || s.kind === 'tag');
    expect(scoreKinds.length).toBeGreaterThanOrEqual(1);
    for (const s of scoreKinds) {expect(s.kind).toBe('token');}
  });
});
