import * as THREE from 'three';
import { getSwarm } from './swarms.js';
import type { Strifer } from './Strifer.js';

// Per-frame instance pose: body root from yaw/pitch/roll, dipping fins
// while hovering, muzzle glow that heats up when charging a bolt.

const PART_BODY = 0;
const PART_WING = 1;
const PART_EYE = 2;
const WINGS_PER = 2;
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export function writeInstances(s: Strifer): void {
    if (!s.hasSlots) return;
    const swarm = getSwarm('strifer');
    if (!swarm) return;
    const slot = s.swarmSlot;
    const r = s.radius;

    _e.set(s.pitch, s.yaw, s.roll, 'YXZ');
    _q.setFromEuler(_e);
    _p.copy(s.pos);
    _root.compose(_p, _q, _s.setScalar(r));

    const fr = s.flash > 0 ? 4 : 1;
    const cr = s.color.r * fr, cg = s.color.g * fr, cb = s.color.b * fr;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, cr, cg, cb);

    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      // fins dip while hovering — reads as the drone planting itself to fire
      const dip = s.state === 'hover' ? 0.25 : 0;
      _local.compose(_v.set(side * 0.55, 0.05, -0.15), _q.identity(), _s.setScalar(1));
      _world.multiplyMatrices(_root, _local);
      _e.set(0, 0, side * dip, 'XYZ');
      _q.setFromEuler(_e);
      _local.compose(_p.set(0, 0, 0), _q, _s.set(1, 1, 1));
      _world.multiply(_local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
      swarm.setColor(PART_WING, slot * WINGS_PER + i, cr * 0.8, cg * 0.8, cb * 0.8);
    }

    // muzzle glow: bright while hovering (charging a bolt), dim on orbit
    const hot = s.state === 'hover' ? 2.2 : 0.8;
    _local.compose(_v.set(0, 0.05, 1.35), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot, _world);
    swarm.setColor(PART_EYE, slot, hot, hot * 0.55, hot * 0.25);
  }

