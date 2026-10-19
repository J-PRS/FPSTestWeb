import { describe, it, expect } from 'bun:test';
import { makeSimBall, stepBall, BALL_ENRAGE_TIMEOUT } from '../../shared/ballSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { BallCombat } from '../src/ballCombat.ts';
import type { PlayerManager } from '../src/PlayerManager.ts';

// The enrage leash teleports a ball ~600m+ in one step. A creatureHit
// claim in flight that step is honestly stale — it was fired at the
// pre-teleport site the client still rendered. The range check used to
// judge live-pos only, so the legit claim dropped (bigSoak flake:
// 'creatureHit dropped: out of range', dist 626m). pset/px/py/pz now
// remembers the pre-teleport site and the gate accepts either.

const FLAT: Heightfield = { size: 64, data: new Uint8Array(64 * 64), stride: 1 };

function makeCombat(ballPos: { x: number; y: number; z: number }, claimerPos: { x: number; y: number; z: number }) {
  const b = makeSimBall(1, 0, 0, ballPos, { x: 0, y: 0, z: 0 });
  const balls = new Map([[b.id, b]]);
  const claimer = { position: { ...claimerPos }, isDead: false };
  const combat = new BallCombat({
    balls: () => balls,
    field: () => FLAT,
    players: { getPlayer: () => claimer } as unknown as PlayerManager,
    segment: () => {},
    kill: () => {},
  });
  return { b, combat };
}

describe('creatureHit range gate', () => {
  it('drops a claimer far from every site the ball has been', () => {
    const { combat, b } = makeCombat({ x: 0, y: 0, z: 0 }, { x: 700, y: 0, z: 0 });
    const hp = b.health;
    expect(combat.handleHit('p', b.id, 10).reason).toBe('range');
    expect(b.health).toBe(hp);
  });

  it('a claim fired at the pre-teleport site still lands after the leash', () => {
    const { b, combat } = makeCombat(
      { x: 400, y: 100, z: -500 }, // teleports near the target…
      { x: 395, y: 100, z: -495 }, // …claimer stood at the OLD site
    );
    // Enrage budget spent → the next authoritative step teleports.
    b.enraged = true;
    b.enrageTimer = BALL_ENRAGE_TIMEOUT + 1;
    stepBall(b, 1 / 30, FLAT, { x: 0, y: 0, z: 0 }, true);
    expect(b.pset).toBe(true);
    // Live pos is now 500+m from the claimer — the old gate dropped here.
    expect(Math.hypot(b.x - 395, b.y - 100, b.z - (-495))).toBeGreaterThan(400);
    expect(combat.handleHit('p', b.id, 10).reason).not.toBe('range');
    expect(b.health).toBe(b.maxHealth - 10);
  });
});
