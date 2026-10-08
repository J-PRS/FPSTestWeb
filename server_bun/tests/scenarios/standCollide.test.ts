import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, flat, step, watch } from './harness.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { CLASS_STATS } from '../../../shared/botClasses.ts';

// Authored 'stand' structure collision: the innate flag socket is
// visual-only (no injected hull), so a map that wants a platform writes
// the box itself. These scenarios drive the real sims into an authored
// 2.4w×0.8h plinth — a walker pushing the face, a body dropped onto
// it, a bolt crossing the slab — so authored stands can't silently
// lose their solidity.

const FLOOR = hmHeight(flat, 0, 0);
const HOME = { x: 0, y: FLOOR, z: 0 };
const SKIRT_FACE = 1.2;      // 2.4-wide box, half extent
const DECK_TOP = FLOOR + 0.8;
const STAND = { kind: 'stand' as const, pos: { ...HOME }, size: { x: 2.4, y: 0.8, z: 2.4 } };

function standRoom() {
  return mkRoom({ mode: 'ctf', bots: 0, structures: [STAND],
    bases: { alpha: { x: -120, y: FLOOR, z: 0 }, bravo: { x: 0, y: FLOOR, z: 40 } } }, 'ctf');
}

/** Track a medium body in the move shadow — same wiring as jetReach:
 *  addPlayer doesn't seed a shadow, the sim needs track+body. */
function trackBody(room: ReturnType<typeof mkRoom>, id: string, pos: { x: number; y: number; z: number }, yaw: number): void {
  const st = CLASS_STATS.medium;
  room.players.addPlayer(id, undefined, 'none', 'medium');
  room.moveSim.track(id, pos, yaw);
  room.moveSim.setSpeedScale(id, st.speedScale);
  room.moveSim.setBody(id, st.mass, st.eyeHeight, st.radius);
}

describe('scenario: authored stand collision', () => {
  it('no stand is auto-injected — a bare flag home is socket-on-dirt', () => {
    const room = standRoom();
    // The only stand collider is the authored one — flag homes add none.
    const stands = room.ballSim.colliders.filter((c) => c.hx === 1.2 && c.hy === 0.4);
    expect(stands.length).toBe(1);
    expect(stands[0]!.cx).toBeCloseTo(HOME.x, 3);
  });

  it('a player pushing into an authored stand is stopped at the plinth face', () => {
    const room = standRoom();
    const st = CLASS_STATS.medium;
    trackBody(room, 'pusher', { x: 15, y: FLOOR + st.eyeHeight, z: 0 }, -Math.PI / 2); // forward = -x
    room.moveSim.setInput('pusher', { forward: 1 });
    for (let i = 0; i < 80; i++) {
      step(room, 1);
      // Below plinth top the capsule may never enter the hull footprint.
      const s = room.moveSim.simState('pusher')!.pos;
      if (s.y - st.eyeHeight < DECK_TOP - 0.01) {
        expect(Math.abs(s.x)).toBeGreaterThanOrEqual(SKIRT_FACE);
      }
    }
    // Knee-high: the solver may let him step ON the platform — legal. The
    // failure this guards is tunneling THROUGH the plinth at deck level.
    const s = room.moveSim.simState('pusher')!.pos;
    expect(s.x).toBeLessThan(15); // traveled toward the stand
  });

  it('a body dropped on an authored stand lands on the plinth top', () => {
    const room = standRoom();
    const st = CLASS_STATS.medium;
    trackBody(room, 'drop', { x: 0, y: FLOOR + 8, z: 0 }, 0);
    for (let i = 0; i < 80; i++) step(room, 1);
    const s = room.moveSim.simState('drop')!.pos;
    // Eye rests at deck top + eye height — the top face is walkable.
    expect(s.y).toBeGreaterThan(DECK_TOP + st.eyeHeight - 0.5);
    expect(s.y).toBeLessThan(DECK_TOP + st.eyeHeight + 0.5);
  });

  it('a bolt into the slab detonates on the hull, never reaching the pole', () => {
    const room = standRoom();
    const w = watch(room);
    room.players.addPlayer('shooter');
    // Aim at plinth mid-height — the socket face at x=1.2 eats the bolt.
    room.projectiles.spawn('shooter', WeaponType.PlasmaGun,
      { x: 30, y: FLOOR + 0.4, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const projs = (room.projectiles as unknown as { projs: Map<string, { p: { pos: { x: number; y: number } } }> }).projs;
    for (let i = 0; i < 60; i++) {
      step(room, 1);
      for (const pr of projs.values()) {
        // While still inside the plinth's height band it may not cross
        // the face line — a live bolt at x<1.2 means it tunneled.
        if (pr.p.pos.y < FLOOR + 0.8) expect(pr.p.pos.x).toBeGreaterThanOrEqual(SKIRT_FACE - 0.5);
      }
      if (w.count('projectileDestroyed') > 0) break;
    }
    expect(w.count('projectileDestroyed')).toBeGreaterThan(0);
  });
});
