import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, flat, step, watch } from './harness.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { CLASS_STATS } from '../../../shared/botClasses.ts';

// Flag-stand collision end-to-end: the server injects two 'stand' box
// hulls per flag home (shared/mapSpec flagStandSpecs — skirt 12w×2.2h
// centered at the base, deck 9w×0.85h sitting on it, top ≈ base+3.05).
// These scenarios drive the real sims into them — a walker pushing the
// face, a body dropped onto the deck, a bolt crossing the slab — so the
// hull can't silently drift from the dais mesh it approximates.

const FLOOR = hmHeight(flat, 0, 0);
const HOME = { x: 0, y: FLOOR, z: 0 };
const SKIRT_FACE = 6;        // 12-wide box, half extent
const DECK_TOP = FLOOR + 3.05;

function ctfRoom() {
  return mkRoom({
    mode: 'ctf', bots: 0,
    bases: { alpha: { x: -120, y: FLOOR, z: 0 }, bravo: { ...HOME } },
  }, 'ctf');
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

describe('scenario: flag stand collision', () => {
  it('a player pushing into the dais is stopped at the skirt face', () => {
    const room = ctfRoom();
    const st = CLASS_STATS.medium;
    trackBody(room, 'pusher', { x: 15, y: FLOOR + st.eyeHeight, z: 0 }, -Math.PI / 2); // forward = -x
    room.moveSim.setInput('pusher', { forward: 1 });
    for (let i = 0; i < 80; i++) {
      step(room, 1);
      // Below deck top the capsule may never enter the hull footprint.
      const s = room.moveSim.simState('pusher')!.pos;
      if (s.y - st.eyeHeight < DECK_TOP - 0.01) {
        expect(Math.abs(s.x)).toBeGreaterThanOrEqual(SKIRT_FACE);
      }
    }
    const s = room.moveSim.simState('pusher')!.pos;
    expect(s.x).toBeGreaterThan(SKIRT_FACE); // still outside — blocked, not through
    expect(s.x).toBeLessThan(15);            // but it did travel toward the stand
  });

  it('a body dropped on the dais lands on the deck top', () => {
    const room = ctfRoom();
    const st = CLASS_STATS.medium;
    trackBody(room, 'drop', { x: 0, y: FLOOR + 8, z: 0 }, 0);
    for (let i = 0; i < 80; i++) step(room, 1);
    const s = room.moveSim.simState('drop')!.pos;
    // Eye rests at deck top + eye height — the top face is walkable.
    expect(s.y).toBeGreaterThan(DECK_TOP + st.eyeHeight - 0.5);
    expect(s.y).toBeLessThan(DECK_TOP + st.eyeHeight + 0.5);
  });

  it('a bolt into the slab detonates on the hull, never reaching the pole', () => {
    const room = ctfRoom();
    const w = watch(room);
    room.players.addPlayer('shooter');
    // Aim at skirt mid-height — the 12m face at x=6 should eat the bolt.
    room.projectiles.spawn('shooter', WeaponType.PlasmaGun,
      { x: 30, y: FLOOR + 1.5, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const projs = (room.projectiles as unknown as { projs: Map<string, { p: { pos: { x: number; y: number } } }> }).projs;
    for (let i = 0; i < 60; i++) {
      step(room, 1);
      for (const pr of projs.values()) {
        // While still inside the skirt's height band it may not cross
        // the face line — a live bolt at x<6 means it tunneled.
        if (pr.p.pos.y < FLOOR + 2.2) expect(pr.p.pos.x).toBeGreaterThanOrEqual(SKIRT_FACE - 0.5);
      }
      if (w.count('projectileDestroyed') > 0) break;
    }
    expect(w.count('projectileDestroyed')).toBeGreaterThan(0);
  });
});
