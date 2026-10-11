import * as THREE from 'three';
import { getSwarm } from './swarms.js';
import type { Strifer } from './Strifer.js';

// Per-frame instance pose: shard root from yaw/pitch/roll, blade vanes
// canting down while hovering, nose glyph heating up when charging a bolt.

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
const _rot = new THREE.Matrix4();
const _identQ = new THREE.Quaternion();

export function writeInstances(s: Strifer): void {
    if (!s.hasSlots) {return;}
    const swarm = getSwarm('strifer');
    if (!swarm) {return;}
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

    const hovering = s.state === 'hover';
    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      // Vanes cant down while hovering — the platform braces to fire.
      // The -X scale mirrors the right vane's geometry for the left;
      // wingMat is DoubleSide so the flipped winding still shades.
      const dip = hovering ? 0.3 : 0;
      _e.set(0, -0.12, 0.12 + dip, 'YXZ');
      _q.setFromEuler(_e);
      // Mirror OUTSIDE the rotation — compose()'s T·R·S applies the -X
      // scale before the quaternion, which lands the roll inverted on
      // the left vane (one tip up, one down). T·M·R mirrors the posed
      // result instead: symmetric cant, mirrored crescent.
      _rot.makeRotationFromQuaternion(_q);
      _local.compose(_v.set(side * 0.42, 0.08, -0.1), _identQ, _s.set(side < 0 ? -1 : 1, 1, 1));
      _local.multiply(_rot);
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
      swarm.setColor(PART_WING, slot * WINGS_PER + i, cr * 0.75, cg * 0.75, cb * 0.75);
    }

    // Nose glyph slit — vertical carved line, burns while a bolt charges.
    const hot = hovering ? 2.2 : 0.8;
    _local.compose(_v.set(0, 0.02, 1.18), _q.identity(), _s.set(0.3, 0.65, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot, _world);
    swarm.setColor(PART_EYE, slot, hot, hot * 0.55, hot * 0.25);
  }
