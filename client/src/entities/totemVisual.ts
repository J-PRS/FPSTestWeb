import * as THREE from 'three';
import { getSwarm } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

export const PART_SHAFT = 0;
export const PART_CAP = 1;
export const PART_EYE = 2;      // glow slit quad near the top
export const PART_BEAM = 3;     // aim-beam quad — zero-scale when idle
export const PART_SHIMMER = 4;  // blink-in arrival column — zero-scale when idle
export const PART_CORE = 5;     // white-hot core of the FIRED ray — zero-scale otherwise

const _shaftGeo = new THREE.CylinderGeometry(0.35, 0.7, 4.2, 4); // 4-sided obelisk
const _capGeo = new THREE.ConeGeometry(0.5, 1.0, 4);
// Aim beam — a thin quad stretched between totem and player during charge;
// origin at the totem end so scaling +z extends it downrange.
const _beamGeo = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateY(Math.PI / 2); // lies along +z
  g.translate(0, 0, 0.5);
  return g;
})();
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _shaftMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;
let _beamMat: THREE.MeshBasicMaterial | null = null;
let _shimmerMat: THREE.MeshBasicMaterial | null = null;
let _coreMat: THREE.MeshBasicMaterial | null = null;

export function totemParts(): SwarmPart[] {
  if (!_shaftMat) {_shaftMat = new THREE.MeshLambertMaterial({ color: 0xffffff });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x66ddff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  if (!_beamMat) {_beamMat = new THREE.MeshBasicMaterial({
    color: 0xff3344, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  if (!_shimmerMat) {_shimmerMat = new THREE.MeshBasicMaterial({
    color: 0x8899ff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false,
  });}
  if (!_coreMat) {_coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  return [
    { geometry: _shaftGeo, material: _shaftMat, castShadow: true },
    { geometry: _capGeo, material: _shaftMat },
    { geometry: _eyeGeo, material: _eyeMat },
    { geometry: _beamGeo, material: _beamMat },
    { geometry: _shaftGeo, material: _shimmerMat },
    { geometry: _beamGeo, material: _coreMat },
  ];
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

// Zero matrix — hides an instanced part without touching the slot count.
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
function zeroM(out: THREE.Matrix4): THREE.Matrix4 {
  return out.copy(_zero);
}

/** The fields writeTotemInstances reads — kept flat on Totem, the module
 *  stays a pure function over them so the instance math lives apart from
 *  the state machine. */
export interface TotemVisHost {
  hasSlots: boolean;
  swarmSlot: number;
  radius: number;
  pos: THREE.Vector3;
  color: THREE.Color;
  state: string;
  bodyScale: number;
  eyeScale: number;
  eyeBright: number;
  beamOn: boolean;
  beamOpacity: number;
  beamWidth: number;
  beamFade: number;
  shimmerOn: boolean;
  shimmerPulse: number;
  flash: number;
  chargeGlow: number;
  staggerT: number;
  lockDir: THREE.Vector3;
  lockDist: number;
}

export function writeTotemInstances(t: TotemVisHost): void {
  if (!t.hasSlots) {return;}
  const swarm = getSwarm('totem');
  if (!swarm) {return;}
  const slot = t.swarmSlot;
  const r = t.radius;
  const visible = t.state !== 'blinkIn';
  const bs = visible ? t.bodyScale : 0;

  // Shaft + cap ride the body scale (materialize grow / blinkOut shrink)
  _q.identity();
  _root.compose(t.pos, _q, _s.setScalar(r * Math.max(0.0001, bs)));
  _local.compose(_p.set(0, 2.1, 0), _q.identity(), _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_SHAFT, slot, _world);

  const fr = t.flash > 0 ? 4 : 1;
  const cg = t.chargeGlow;
  const cr = t.color.r * fr + cg * 0.6;
  const cgg = t.color.g * fr + cg * 0.3;
  const cb = t.color.b * fr + cg;
  swarm.setColor(PART_SHAFT, slot, cr, cgg, cb);
  swarm.setColor(PART_CAP, slot, cr, cgg, cb);

  _local.compose(_p.set(0, 4.7, 0), _q.identity(), _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_CAP, slot, _world);

  // Eye slit — charges blinding-white before the shot
  _local.compose(_p.set(0, 3.9, 0), _q.identity(), _s.setScalar(t.eyeScale * 0.8));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_EYE, slot, visible ? _world : zeroM(_world));
  // Staggered = pinned: the eye strobes dim — a readable "it's anchored"
  // tell so the counterplay state is visible, not just mechanical.
  const eb = t.staggerT > 0
    ? t.eyeBright * (0.25 + 0.3 * Math.abs(Math.sin(t.staggerT * 25)))
    : t.eyeBright;
  swarm.setColor(PART_EYE, slot, 0.4 + eb, 0.85 + eb * 0.4, 1 + eb * 0.5);

  // Aim beam — stretched from eye height down the locked line
  if (t.beamOn || t.beamFade > 0) {
    _p.set(t.pos.x, t.pos.y + 3.9 * r, t.pos.z);
    _v2.copy(_p).addScaledVector(t.lockDir, t.lockDist);
    // Matrix4.lookAt aims +Z eye→target — swapped args on purpose:
    // eye=_v2 (far end), target=_p (totem) makes +Z point totem→player,
    // which is where the beam quad extends. The old order drew the
    // telegraph line BACKWARD — "totem fires in a random direction".
    _root.lookAt(_v2, _p, _v.set(0, 1, 0));
    _q.setFromRotationMatrix(_root);
    _root.compose(_p, _q, _s.set(1, t.beamWidth, t.lockDist));
    swarm.setMatrix(PART_BEAM, slot, _root);
    const bo = t.beamOpacity;
    if (t.beamFade > 0) {
      // FIRED: two-layer energy ray. The outer quad becomes a cyan
      // plasma sheath; a thinner WHITE core quad rides inside it —
      // the classic hot-center/colored-edge discharge read.
      swarm.setColor(PART_BEAM, slot, bo * 0.3, bo * 0.85, bo * 1.7);
      _local.compose(_p, _q, _s.set(1, t.beamWidth * 0.35, t.lockDist));
      swarm.setMatrix(PART_CORE, slot, _local);
      swarm.setColor(PART_CORE, slot, bo * 2.2, bo * 2.2, bo * 2.2);
    } else {
      // Charging: red aiming laser that narrows as it heats up
      swarm.setColor(PART_BEAM, slot, bo, bo * (0.35 - t.beamWidth * 0.1), bo * 0.3);
      swarm.setMatrix(PART_CORE, slot, zeroM(_local));
    }
  } else {
    swarm.setMatrix(PART_BEAM, slot, zeroM(_root));
    swarm.setMatrix(PART_CORE, slot, zeroM(_root));
  }

  // Arrival shimmer column during blinkIn
  if (t.shimmerOn) {
    _p.set(t.pos.x, t.pos.y + 2.4, t.pos.z);
    _local.compose(_p, _q.identity(), _s.set(r, 1.3, r));
    swarm.setMatrix(PART_SHIMMER, slot, _local);
    const sp = t.shimmerPulse;
    swarm.setColor(PART_SHIMMER, slot, sp, sp, sp);
  } else {
    swarm.setMatrix(PART_SHIMMER, slot, zeroM(_local));
  }
}
