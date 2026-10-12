import * as THREE from 'three';
import { getSwarm, getShadows } from './swarms.js';
import { SNAKE_SPEED } from '../core/config.js';
import type { Snake } from './Snake.js';
import type { Terrain } from '../world/terrain.js';

// Per-frame instance pose: the body is a real SPINE — the head leads the
// anchor, drops breadcrumbs as it travels, and each segment is seated a
// fixed arc-length behind the head along that recorded path. Curves, S-
// turns and the lunge all come out of the path, not a canned wave; each
// segment samples its own terrain height so the belly stays on the dirt.

const PART_SEG = 0;
const PART_EYE = 1;
const SEGS_PER = 22; // matches Snake.ts — tighter spacing so thin tail lobes still overlap
const EYES_PER = 2;
const BODY_LEN = 7; // total spine length in radius units — a real viper
const STEP = 0.18;    // trail breadcrumb spacing, radius units
const _local = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Record the head's traveled path — flat [x,z,...], newest first.
export function pushTrail(s: Snake): void {
  const r = s.radius;
  const lead = BODY_LEN * 0.5 * r;
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  const hx = s.pos.x + fx * lead, hz = s.pos.z + fz * lead;
  const tr = s.trail;
  const step = STEP * r;
  if (tr.length >= 2) {
    const dx = hx - tr[0], dz = hz - tr[1];
    if (dx * dx + dz * dz < step * step) {return;}
  }
  tr.unshift(hx, hz);
  const maxPts = Math.ceil(BODY_LEN * 1.6 / STEP) * 2;
  if (tr.length > maxPts) {tr.length = maxPts;}
}

// Walk the trail to a point `dist` (radius units) behind the head.
// Returns interpolated position; short trails stretch behind the head
// along its backward axis so a fresh spawn reads as a straight snake.
function sampleTrail(s: Snake, dist: number, out: { x: number; z: number }): void {
  const r = s.radius;
  const tr = s.trail;
  const d = dist * r;
  if (tr.length < 2) {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const lead = BODY_LEN * 0.5 * r;
    out.x = s.pos.x + fx * (lead - d);
    out.z = s.pos.z + fz * (lead - d);
    return;
  }
  let acc = 0;
  for (let i = 0; i + 3 < tr.length; i += 2) {
    const dx = tr[i + 2] - tr[i], dz = tr[i + 3] - tr[i + 1];
    const seg = Math.hypot(dx, dz);
    if (acc + seg >= d && seg > 1e-6) {
      const k = (d - acc) / seg;
      out.x = tr[i] + dx * k;
      out.z = tr[i + 1] + dz * k;
      return;
    }
    acc += seg;
  }
  // Ran off the end — extend straight back from the last breadcrumb.
  const n = tr.length;
  const bx = tr[n - 2], bz = tr[n - 1];
  const px = n >= 4 ? bx - tr[n - 4] : Math.sin(s.yaw);
  const pz = n >= 4 ? bz - tr[n - 3] : Math.cos(s.yaw);
  const pl = Math.hypot(px, pz) || 1;
  out.x = bx + (px / pl) * (d - acc);
  out.z = bz + (pz / pl) * (d - acc);
}

const _pt = { x: 0, z: 0 };
const _ahead = { x: 0, z: 0 };
const _behind = { x: 0, z: 0 };
// Segment world positions, computed before orientation — a lobe can only
// aim along the spine once both its neighbors are placed.
const _segX = new Float32Array(SEGS_PER);
const _segY = new Float32Array(SEGS_PER);
const _segZ = new Float32Array(SEGS_PER);
const _segW = new Float32Array(SEGS_PER);
const _segB = new Float32Array(SEGS_PER);

/** Anatomical profile head→tail: head bulge, neck pinch, max girth
 *  ~40% back, whiplash tail. Slim — fat reads grub, not viper. */
function segWidth(t: number): number {
  let w;
  if (t < 0.1) {w = 0.4 - t * 1.2;}
  else if (t < 0.45) {w = 0.28 + (t - 0.1) * 0.17;}
  else if (t < 0.8) {w = 0.34 - (t - 0.45) * 0.55;}
  else {w = 0.145 - (t - 0.8) * 0.55;}
  return w * 1.3;
}

/** Aim each lobe along the real 3D chain direction between its placed
 *  neighbours — covers coil rise, leap arcs and per-seg terrain steps. */
function orientSegments(s: Snake, swarm: NonNullable<ReturnType<typeof getSwarm>>, slot: number, r: number, fr: number): void {
  for (let i = 0; i < SEGS_PER; i += 1) {
    const iA = Math.max(0, i - 1), iB = Math.min(SEGS_PER - 1, i + 1);
    const dx = _segX[iA] - _segX[iB];
    const dy = _segY[iA] - _segY[iB];
    const dz = _segZ[iA] - _segZ[iB];
    const segYaw = Math.atan2(dx, dz);
    // YXZ like the turret mount: yaw to the horizontal component, then
    // pitch the lobe's +Z onto the true rise to the next segment.
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    _e.set(-pitch, segYaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    const w = _segW[i];
    _local.compose(
      _p.set(_segX[i], _segY[i], _segZ[i]),
      _q,
      // Stretched along the spine tangent: arc-length spacing becomes a
      // chord across curves — near-spherical lobes show gaps in bends;
      // scale 1.8 on Z overlaps them like plates.
      _s.set(w * r, w * r, w * r * 1.8),
    );
    // _local is already in world space — trail samples are world coords.
    swarm.setMatrix(PART_SEG, slot * SEGS_PER + i, _local);
    const band = _segB[i];
    swarm.setColor(PART_SEG, slot * SEGS_PER + i,
      s.color.r * fr * band, s.color.g * fr * band, s.color.b * fr * band);
  }
}



export function writeInstances(s: Snake, terrain: Terrain): void {
    if (!s.hasSlots) {return;}
    const swarm = getSwarm('snake');
    if (!swarm) {return;}
    const slot = s.swarmSlot;
    const r = s.radius;

    const fr = s.flash > 0 ? 4 : 1;
    const coiling = s.windup > 0 ? 1 : 0;
    const lunging = s.lunge > 0 ? 1 : 0;
    const spd = Math.hypot(s.vel.x, s.vel.z);
    const crawl = Math.min(1, spd / SNAKE_SPEED);
    // Residual undulation on top of the path — the trail already gives the
    // macro-shape; this adds live muscle, swelling toward the tail.
    const waveAmp = (0.12 * crawl + coiling * 0.3) * (1 - lunging * 0.6);
    const spacing = BODY_LEN / SEGS_PER; // arc-length per segment, radius units
    // Leap clearance: the anchor's height over the dirt under IT. Segments
    // get a head-weighted share so the spine arcs — head up, tail still
    // leaving the ground — instead of the whole body levitating or the
    // belly staying glued to the floor mid-flight.
    const air = Math.max(0, s.pos.y - s.radius - terrain.getHeight(s.pos.x, s.pos.z));

    for (let i = 0; i < SEGS_PER; i += 1) {
      const t = i / (SEGS_PER - 1); // 0 head → 1 tail
      sampleTrail(s, i * spacing, _pt);
      // Tangent = centered difference: the point TOWARD the head minus
      // the point behind, so the head lobe itself also gets a real
      // heading (dist-spacing clamps to 0 there — a one-sided diff gave
      // it atan2(0,0)=0 and the head pointed world +Z forever).
      sampleTrail(s, Math.max(0, i * spacing - spacing), _ahead);
      sampleTrail(s, i * spacing + spacing, _behind);
      const tx = _ahead.x - _behind.x, tz = _ahead.z - _behind.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl; // left normal for the S-wave
      const lat = Math.sin(s.animT * 9 - i * 0.7) * waveAmp * (0.2 + 0.8 * t) * r;
      const wx = _pt.x + lat * nx, wz = _pt.z + lat * nz;
      // Belly on the dirt: half the lobe height above THIS spot's ground —
      // never the anchor's. No clamping: downhill segments must sink.
      const segGround = terrain.getHeight(wx, wz);
      const w = segWidth(t);
      // Windup is an S-coil, not a flagpole: the head third rises AND
      // pulls back over the body along its own tangent — a vertical
      // translation alone just levitated a straight tube.
      const rearK = coiling * Math.max(0, 1 - t * 3) ** 2;
      const rear = rearK * 1.6 * r;
      const pull = rearK * 0.9 * r;
      const wx2 = wx - (tx / tl) * pull, wz2 = wz - (tz / tl) * pull;
      // 0.45 ≈ the lobe's true y-radius (geo 0.6 × flat 0.7): seats the
      // belly ON the dirt, not 5cm above it (0.55) or buried (0.35).
      _segX[i] = wx2; _segY[i] = segGround + w * r * 0.45 + rear + air * (1 - t) ** 1.3; _segZ[i] = wz2;
      // Anatomical width + banded viper pattern ride along for pass two.
      _segW[i] = w;
      const band = i % 2 === 0 ? 1 : 0.72;
      _segB[i] = band;
    }

    // Second pass: orient each lobe along the REAL 3D chain direction.
    // The old pose pitched lobes a fixed ~31° during coil — the actual
    // rise is ~53° over one spacing, so neighbours drifted apart and the
    // body visibly split. Slopes hit the same gap via per-seg terrain
    // heights. Aiming at the neighbours covers both for free.
    orientSegments(s, swarm, slot, r, fr);

    // Eyes ride the head segment — same tangent frame.
    sampleTrail(s, spacing * 0.15, _pt);
    sampleTrail(s, 0, _ahead);
    const hx = _ahead.x - _pt.x, hz = _ahead.z - _pt.z;
    const hl = Math.hypot(hx, hz) || 1;
    const headGround = terrain.getHeight(_pt.x, _pt.z);
    const headY = headGround + 0.29 * r + coiling * 1.6 * r + air;
    const ex = -hz / hl, ez = hx / hl; // head left normal
    for (let i = 0; i < EYES_PER; i += 1) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(_pt.x + ex * side * 0.14 * r + (hx / hl) * (0.1 - coiling * 0.9) * r,
               headY + 0.08 * r,
               _pt.z + ez * side * 0.14 * r + (hz / hl) * (0.1 - coiling * 0.9) * r),
        _q.identity(), _s.setScalar(0.11 * r),
      );
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _local);
    }

    getShadows()?.set(s, s.pos, r * 2.2, 0.35);
  }
