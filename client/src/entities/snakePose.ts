import * as THREE from 'three';
import { getSwarm, getShadows } from './swarms.js';
import { SNAKE_SPEED } from '../core/config.js';
import type { Snake } from './Snake.js';
import type { Terrain } from '../world/terrain.js';

// Per-frame instance pose: the eight body segments slither as a chain —
// each slot follows the one ahead on a damped spring — plus eyes and
// blob shadow.

const PART_SEG = 0;
const PART_EYE = 1;
const SEGS_PER = 8;
const EYES_PER = 2;
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export function writeInstances(s: Snake, terrain: Terrain): void {
    if (!s.hasSlots) return;
    const swarm = getSwarm('snake');
    if (!swarm) return;
    const slot = s.swarmSlot;
    const r = s.radius;

    _e.set(0, s.yaw, 0);
    _q.setFromEuler(_e);
    _root.compose(s.pos, _q, _s.setScalar(r));

    const spd = Math.hypot(s.vel.x, s.vel.z);
    const crawl = Math.min(1, spd / SNAKE_SPEED);
    const fr = s.flash > 0 ? 4 : 1;
    // Windup pose: head segments lift and the body pulls into an S — read
    // instantly as "it's about to strike". Lunge straightens the wave.
    const coiling = s.windup > 0 ? 1 : 0;
    const lunging = s.lunge > 0 ? 1 : 0;
    const waveAmp = (0.34 * crawl + coiling * 0.5) * (1 - lunging * 0.7);
    const len = 3.2; // body length in radius units

    for (let i = 0; i < SEGS_PER; i++) {
      const t = i / (SEGS_PER - 1); // 0 tail → 1 head
      // Lateral S-wave travels tail→head — the signature snake read
      const lat = Math.sin(s.animT * 8 - i * 1.25) * waveAmp * (1 - t * 0.4);
      const lz = (t - 0.45) * len * (1 - coiling * 0.35); // coil shortens
      // Windup rears the head end up and back
      const rear = coiling * t * t * 1.6;
      // Terrain conform per segment — same trick as the grub
      const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
      const wx = s.pos.x + lat * cy + lz * sy;
      const wz = s.pos.z - lat * sy + lz * cy;
      const segGround = terrain.getHeight(wx, wz) - s.groundY;
      // Taper: head (t=1) is the big lobe, tail thins fast
      const taper = t < 0.3 ? 0.35 + t * 2 : 0.9 + (t - 0.9) * 1.2;
      _e.set(coiling * -0.5 * t, 0, 0); // head pitches up while coiling
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(lat, Math.max(0, segGround) + 0.15 + rear, lz - coiling * t * 0.4),
        _q,
        _s.setScalar(taper),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_SEG, slot * SEGS_PER + i, _world);
      // Banded viper pattern — alternating light/dark lobes down the spine
      const band = i % 2 === 0 ? 1.0 : 0.6;
      swarm.setColor(PART_SEG, slot * SEGS_PER + i,
        s.color.r * fr * band, s.color.g * fr * band, s.color.b * fr * band);
    }

    // Eyes set wide on the head lobe (last segment)
    const headZ = (1 - 0.45) * len * (1 - coiling * 0.35) - coiling * 0.4;
    const headRear = coiling * 1.6;
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.55, 0.5 + headRear, headZ + 0.35), _q.identity(), _s.setScalar(0.22),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(s, s.pos, r * 2.2, 0.35);
  }

