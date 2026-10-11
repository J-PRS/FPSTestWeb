import * as THREE from 'three';
import { getSwarm,getShadows } from './swarms.js';

import type { Scarab } from './Scarab.js';
import type { Terrain } from '../world/terrain.js';

// Per-frame instance pose: slope-hugging body matrix, six alternating
// scuttle legs, two amber eye quads, ground shadow.

const PART_BODY = 0;
const PART_LEG = 1;
const PART_EYE = 2;
const LEGS_PER = 6;
const EYES_PER = 2;
const _tiltQ = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export function writeInstances(sc: Scarab, terrain: Terrain): void {
    if (!sc.hasSlots) {return;}
    const swarm = getSwarm('scarab');
    if (!swarm) {return;}
    const slot = sc.swarmSlot;
    const r = sc.radius;

    _e.set(0, sc.yaw, 0);
    _q.setFromEuler(_e);
    // Grounded scarabs hug the slope — a skittering pack crossing a hill
    // reads flat-footed instead of piercing the dirt.
    if (!sc.airborne) {
      _tiltQ.setFromUnitVectors(_UP, terrain.getNormal(sc.pos.x, sc.pos.z));
      _q.premultiply(_tiltQ);
    }
    _s.setScalar(r);
    // Seat the VISUAL root low: pos is the hit-capsule center (ground+r),
    // but a scarab is a low-slung skitterer — shell hugs the dirt, short
    // legs sweep it along. Not applied while airborne (a pounce carries
    // the real capsule).
    const seat = sc.airborne ? 0 : r * 0.55;
    _p.set(sc.pos.x, sc.pos.y - seat, sc.pos.z);
    _root.compose(_p, _q, _s);

    const fr = sc.flash > 0 ? 4 : 1;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, sc.color.r * fr, sc.color.g * fr, sc.color.b * fr);

    // Six legs, 3 per side — frantic alternating scuttle, way faster than
    // the crawler's: scarabs are all legs and panic.
    const amp = sc.airborne ? 0.06 : (sc.vel.lengthSq() > 4 ? 0.6 : 0.2);
    for (let i = 0; i < LEGS_PER; i++) {
      const side = i < 3 ? -1 : 1;
      const k = i % 3; // 0 front → 2 rear
      const wiggle = Math.sin(sc.animT * 24 + i * 2.1) * amp;
      _e.set(0, side < 0 ? Math.PI - (k - 1) * 0.5 + wiggle : (k - 1) * 0.5 + wiggle, 0);
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(side * 0.55, 0.15, (k - 1) * 0.6),
        _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_LEG, slot * LEGS_PER + i, _world);
      swarm.setColor(PART_LEG, slot * LEGS_PER + i, sc.color.r * 0.5, sc.color.g * 0.5, sc.color.b * 0.5);
    }

    // Two amber eyes on the head lobe
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.14, 0.25, 0.9), _q.identity(), _s.setScalar(0.3),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(sc, sc.pos, r * 1.1, 0.3);
  }

