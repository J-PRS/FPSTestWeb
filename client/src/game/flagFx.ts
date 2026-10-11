// Flag-return ceremony — shared by the online wire path (net/flags.ts)
// and the offline bot room (botCtf.ts). Keep the read consistent: the
// flag SNAPS home, it doesn't teleport silently.

import * as THREE from 'three';
import { blastBurst, implodeBurst } from '../effects/vfx.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';

const _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Flag snapping back to its stand: a team-colored shimmer CONVERGING on
 *  the socket (the flag re-materializing where it belongs) plus, when
 *  the dropped spot is known, a fast stretched streak flying the return
 *  path — so "it went home" reads at any distance, not just on-site. */
export function flagReturnFx(standPos: THREE.Vector3, team: TeamId | null, from?: THREE.Vector3 | null): void {
  const hex = team ? TEAM_COLORS[team] : 0xFF_D0_66; // rabbit's flag is neutral gold
  _c.setHex(hex);
  const c2: [number, number, number] = [_c.r, _c.g, _c.b];
  implodeBurst(_p.copy(standPos).setY(standPos.y + 1.4), {
    count: 70, rMin: 2.5, rMax: 5, spdMin: 20, spdMax: 32, swirl: 14,
    lifeMin: 0.25, lifeMax: 0.45, sizeMin: 2.2, sizeMax: 3.4,
    c1: [1, 1, 1], c2, opacity: 0.9, stagger: 0.06,
  }, true);
  if (!from || from.distanceToSquared(standPos) < 4) {return;}
  // dir must outlive this call — a cold-vfx queue holds the spec object.
  const dir = new THREE.Vector3().subVectors(standPos, from).normalize();
  const spd = from.distanceTo(standPos) / 0.35;
  blastBurst(_p.copy(from).setY(from.y + 1), {
    count: 46, dir, spread: 0.05,
    spdMin: spd * 0.9, spdMax: spd * 1.15, vy: 0,
    lifeMin: 0.28, lifeMax: 0.4, sizeMin: 0.6, sizeMax: 1.1,
    gravity: 0, c1: [1, 1, 1], c2, opacity: 0.85,
    stretched: true, stretchLen: 12,
  }, true);
}
