import * as THREE from 'three';

import { GRAVITY, BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import { GlowBatch } from '../effects/glowBatch.js';
import { metalMat } from './procMetal.js';
import { makePartPool, takeSlot, releaseSlot, type PartPool } from './deployPool.js';
import { parityMiss, parityStamp } from '../game/parity.js';
import { NUG_TUMBLE, type PickupKind } from '../../../shared/pickups.js';
import { getHeightfield } from '../world/heightmap.js';
import { hmSettleWalkable } from '../../../shared/heightfield.js';

// Tighter falloff than the shared glow: hot core, fast edge fade — the
// halo marks the item at range without washing a big blob over it.
const getNuggetTex = (): THREE.Texture<unknown, THREE.TextureEventMap> => getGlowTexture(32, 0.12, 0.5);

const NUGGET_RADIUS = 0.3;
const BOUNCE = 0.25;          // vertical restitution on terrain hits
const GROUND_FRICTION = 0.6;  // horizontal damping per bounce
const SETTLE_SPEED = 0.8;     // below this on ground => settle
const MAGNET_RADIUS = 7;    // start flying toward player inside this
const PICKUP_RADIUS = 1.3;
const MAGNET_ACCEL = 90;      // lerp toward target speed
const MAGNET_MAX_SPEED = 45;
const TRAIL_INTERVAL = 0.035;
const LIFETIME = 30;          // despawn if never picked up

const NUGGET_GEO = new THREE.IcosahedronGeometry(NUGGET_RADIUS, 0);
// Borderlands-style sky beam for tokens — a tall additive shaft the
// size doesn't change with distance, so a dropped pile reads at range.
export const BEAM_GEO = new THREE.CylinderGeometry(0.18, 0.3, 16, 6, 1, true);
// Vertical alpha ramp (v=0 bottom → v=1 top): solid shaft, dissolving
// crown — a hard sky cutoff reads as a UI rod, not a light beam.
export const BEAM_ALPHA = ((): THREE.Texture => {
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createLinearGradient(0, 64, 0, 0); // canvas bottom = v0 = shaft base
  grad.addColorStop(0, '#fff');   // opaque at the base
  grad.addColorStop(0.55, '#fff');
  grad.addColorStop(1, '#000');   // dissolves to nothing at the crown
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
})();
const BEAM_MAT = new THREE.MeshBasicMaterial({
  color: 0xFF_FF_FF, transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  alphaMap: BEAM_ALPHA,
});
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Nugget bodies/accents draw from shared InstancedMeshes per shape — a
// busy fight drops 15-20 gems and each real Mesh was 2 draws + a sprite.
// Kind tint rides instanceColor so one pool serves every drop color.
const POOL_CAP = 256;
interface NuggetPools { body: PartPool; accent: PartPool | null; }
const _pools = new Map<THREE.BufferGeometry, NuggetPools>();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _beamPos = new THREE.Vector3();
let _beamPool: PartPool | null = null;
let _glowBatch: GlowBatch | null = null;
/** Same trick as the beam pool — a Sprite + SpriteMaterial per gem was
 *  a draw + material apiece; one instanced quad batch serves all live
 *  halos. */
function glowBatch(scene: THREE.Scene): GlowBatch {
  if (!_glowBatch) {
    _glowBatch = new GlowBatch(scene, getNuggetTex());
    _glowBatch.mesh.layers.enable(BLOOM_LAYER);
  }
  return _glowBatch;
}
/** One shared beam pool — each nugget's shaft was a cloned Mesh +
 *  material (a draw + a material per gem). Same geometry, tint rides
 *  instanceColor; the collect fade lives in scale.y, not opacity. */
function beamPool(scene: THREE.Scene): PartPool {
  if (!_beamPool) {
    _beamPool = makePartPool(scene, BEAM_GEO, BEAM_MAT, POOL_CAP);
    _beamPool.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3).fill(1), 3);
    _beamPool.mesh.layers.enable(BLOOM_LAYER);
  }
  return _beamPool;
}

function poolsFor(scene: THREE.Scene, geo: THREE.BufferGeometry, accentGeo: THREE.BufferGeometry | null, bodyMat: () => THREE.Material): { body: PartPool; accent: PartPool | null } {
  let p = _pools.get(geo);
  if (p) {return p;}
  p = {
    body: makePartPool(scene, geo, bodyMat(), POOL_CAP),
    accent: accentGeo ? makePartPool(scene, accentGeo, new THREE.MeshBasicMaterial({ color: 0xFF_FF_FF }), POOL_CAP) : null,
  };
  p.body.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3).fill(1), 3);
  if (p.accent) {p.accent.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3).fill(1), 3);}
  p.body.mesh.layers.enable(BLOOM_LAYER);
  if (p.accent) {p.accent.mesh.layers.enable(BLOOM_LAYER);}
  _pools.set(geo, p);
  return p;
}

/**
 * Nugget: Vampire-Survivors-style pickup gem dropped by destroyed targets.
 * Inherits a fraction of the victim's velocity, tumbles under gravity,
 * bounces/settles on terrain, then magnet-flies to the player when close.
 */
export class Nugget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Display-only position: for serverOwned nuggets the sim pos only
   *  advances in 50ms parity cells, so painting it raw staircases at
   *  ~20Hz while falling. renderPos lerps between the last two grid
   *  states by the leftover accumulator fraction — the standard
   *  fixed-timestep render interpolation (bounded: no overshoot through
   *  terrain the way an extrapolation could clip mid-cell clamps). */
  private readonly renderPos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  collected = false; // pickup radius reached
  collectNotified = false; // set by caller once pickup effects/score are applied
  dead = false;      // fully finished — safe to remove + dispose
  /** Server-owned gem (MP): no magnet, no local collect, no local TTL —
   *  the wire decides when it's picked up; we just run the same physics. */
  serverOwned = false;
  /** Pickup identity/value — 'token' in headhunt, val = the coin's
   *  denomination. Collectors read these to route the grab reward. */
  kind: PickupKind = 'gem';
  val = 1;

  private scene: THREE.Scene;
  private pools: NuggetPools;
  private slot: number;
  private spinX = 0;
  private spinY = 0;
  private visScale = 1;
  /** Denomination size — token 9s/27s dwarf the 1-coins so a scattered
   *  hoard reads its value at a glance. */
  private sizeMul = 1;
  private pulseColor = new THREE.Color();
  private glowSlot = -1;
  private beamSlot = -1;
  private trailFx: BallTrailDots;
  private trailTimer = 0;
  private age = 0;
  private settled = false;
  private collectFade = 0;
  private scatterTimer = 0; // blast knockback suppresses the magnet briefly
  private baseColor: THREE.Color;
  private emitColor: THREE.Color;

  /** tint: pickup kind sells itself by color — gold gems, green heals,
   *  red tags — no marquee iconography needed. `parts` swaps the plain
   *  gem for a diegetic shape: dark body + accent part in the tint. */
  constructor(scene: THREE.Scene, pos: THREE.Vector3, inheritVel: THREE.Vector3, tint = 0xFF_D5_4A, parts: { body: THREE.BufferGeometry; accent: THREE.BufferGeometry; bodyColor?: number; beam?: boolean } | null = null, sizeMul = 1) {
    this.scene = scene;
    this.sizeMul = sizeMul;
    this.baseColor = new THREE.Color(tint);
    // Emit slightly desaturated so bloom reads hot without clipping to white
    this.emitColor = this.baseColor.clone().lerp(new THREE.Color(0xFF_FF_FF), 0.33);
    this.pos = pos.clone();
    this.renderPos.copy(this.pos);
    this.prevPos.copy(this.pos);
    this.vel = inheritVel.clone();
    // Small random spread so multi-nugget drops scatter naturally
    this.vel.x += (Math.random() - 0.5) * 4;
    this.vel.y += Math.random() * 3 + 1;
    this.vel.z += (Math.random() - 0.5) * 4;

    if (parts) {
      this.pools = poolsFor(scene, parts.body, parts.accent, (): THREE.MeshStandardMaterial => metalMat(parts.bodyColor));
    } else {
      this.pools = poolsFor(scene, NUGGET_GEO, null, (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: 0xFF_FF_FF }));
    }
    this.slot = takeSlot(this.pools.body);
    this.writeInstance();

    // Billboarded glow halo rides the shared quad batch — a Sprite per
    // gem was a draw + material each. Same texture, same depth bias
    // (batch material carries the polygonOffset), alpha/color/size are
    // per-instance writes in updateVisuals.
    this.glowSlot = glowBatch(scene).take();

    if (parts?.beam) {
      this.beamSlot = takeSlot(beamPool(scene));
    }

    // Gold sparkle trail — one slot in the shared dot batch (was a
    // Sprite + SpriteMaterial per dot, one draw call each).
    this.trailFx = new BallTrailDots(scene, { interval: TRAIL_INTERVAL, sizeMul: 0.5 });
  }

  /** playerPos is the player's eye/camera position (player.pos). */
  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, pickupScale = 1): void {
    this.age += dt;
    if (!this.serverOwned && this.age > LIFETIME) {this.collected = true;} // fade out if ignored

    if (this.collected) {
      this.renderPos.copy(this.pos);
      this.updateCollectFade(dt);
      this.trailFx.fade(dt);
      return;
    }

    if (this.scatterTimer > 0) {this.scatterTimer -= dt;}

    // playerPos is the eye position (camera) — aim below it at belt height so
    // pickups sweep into the torso instead of flying into your face
    _target.copy(playerPos).setY(playerPos.y - 0.6);
    const dist = this.pos.distanceTo(_target);

    if (!this.serverOwned && dist < MAGNET_RADIUS && this.scatterTimer <= 0) {
      this.magnetStep(dt, dist, pickupScale);
    } else if (!this.settled) {
      if (this.serverOwned) {this.serverTumble(dt, terrain);} else {this.ballisticStep(dt, terrain);}
    }

    // serverTumble integrates internally (server ordering) — the shared
    // pos+vel*dt line would double-step it.
    if (!this.serverOwned) {this.pos.addScaledVector(this.vel, dt);}
    this.renderPos.copy(this.pos);
    if (this.serverOwned && !this.settled) {
      this.renderPos.lerpVectors(this.prevPos, this.pos, Math.min(1, this.tumbleAcc / 0.05));
    }
    this.updateVisuals(dt);
    this.emitTrail(dt);
    this.trailFx.fade(dt);
  }

  private updateCollectFade(dt: number): void {
    this.collectFade += dt * 8;
    this.visScale = Math.max(0, 1 - this.collectFade);
    this.writeInstance();
    this.writeGlow(this.renderPos.y, Math.max(0, 0.85 * (1 - this.collectFade)));
    if (this.beamSlot >= 0) {this.writeBeam(this.renderPos.y);}
    if (this.collectFade >= 1 && this.trailFx.size === 0) {this.dead = true;}
  }

  private writeInstance(): void {
    if (this.slot < 0) {return;}
    _q.setFromEuler(_e.set(this.spinX, this.spinY, 0));
    const m = _m.compose(this.renderPos, _q, _s.setScalar(this.visScale * this.sizeMul));
    this.pools.body.mesh.setMatrixAt(this.slot, m);
    this.pools.body.mesh.instanceMatrix.needsUpdate = true;
    this.pools.body.mesh.setColorAt(this.slot, this.pulseColor.copy(this.emitColor).multiplyScalar(EMIT_GAIN));
    this.pools.body.mesh.instanceColor!.needsUpdate = true;
    if (this.pools.accent) {
      this.pools.accent.mesh.setMatrixAt(this.slot, m);
      this.pools.accent.mesh.instanceMatrix.needsUpdate = true;
      this.pools.accent.mesh.setColorAt(this.slot, this.pulseColor);
      this.pools.accent.mesh.instanceColor!.needsUpdate = true;
    }
  }

  private magnetStep(dt: number, dist: number, pickupScale = 1): void {
    // Accelerate toward player, speed ramps up as it closes in
    _dir.copy(_target).sub(this.pos).normalize();
    const speed = Math.min(MAGNET_MAX_SPEED, MAGNET_ACCEL * this.age * 0.5 + 15);
    this.vel.lerp(_dir.multiplyScalar(speed), Math.min(1, dt * 10));
    this.settled = false;
    if (dist < PICKUP_RADIUS * pickupScale) {this.collected = true;}
  }

  private ballisticStep(dt: number, terrain: Terrain): void {
    this.vel.y += GRAVITY * dt;
    // Rest on the drawn surface, not the smooth field — the flat
    // triangles dip under bilinear on convex ground and a field rest
    // reads as a nugget hanging midair.
    const gy = terrain.getRenderedHeight(this.pos.x, this.pos.z);
    if (this.pos.y + this.vel.y * dt > gy + NUGGET_RADIUS) {return;}
    this.pos.y = gy + NUGGET_RADIUS;
    if (Math.abs(this.vel.y) > 2) {
      this.vel.y = -this.vel.y * BOUNCE;
      this.vel.x *= GROUND_FRICTION;
      this.vel.z *= GROUND_FRICTION;
      return;
    }
    // Resting: bleed off remaining motion, then settle
    this.vel.y = 0;
    this.vel.x *= Math.max(0, 1 - dt * 6);
    this.vel.z *= Math.max(0, 1 - dt * 6);
    if (this.vel.lengthSq() < SETTLE_SPEED * SETTLE_SPEED) {
      this.vel.set(0, 0, 0);
      this.settled = true;
    }
  }

  // Forceable — explosions scatter nuggets. Light objects: full force plus an
  // up-kick so they pop off the dirt instead of skidding. Knocked loose from
  // the settle state; magnet is suppressed for a beat so the blast actually
  // throws them instead of being lerped straight back at the player.
  applyKnockback(from: THREE.Vector3, force: number): void {
    if (this.collected || this.dead
      || !Number.isFinite(from.x + from.y + from.z + force)) {return;}
    if (this.serverOwned) {this.serverKnock(from, force, 1); return;}
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force);
    this.vel.y += Math.abs(force) * 0.4; // server-parity pop (RoomPickups.knock)
    this.settled = false;
    this.scatterTimer = 0.4;
  }

  /** Exact mirror of RoomPickups.knock + tick for wire-owned gems: the
   *  push is XZ-only (dir scaled by the 3-D distance), the up-pop is a
   *  fixed fraction, and the tumble bleeds with no bounce. Any drift vs
   *  this math becomes a nugrest snap when the server publishes its rest. */
  private serverKnock(from: THREE.Vector3, force: number, sign: 1 | -1): void {
    const dx = this.pos.x - from.x, dy = this.pos.y - from.y, dz = this.pos.z - from.z;
    const d = (dx * dx + dy * dy + dz * dz) ** 0.5 || 1;
    this.vel.x += (dx / d) * force * sign;
    this.vel.z += (dz / d) * force * sign;
    this.vel.y += Math.abs(force) * NUG_TUMBLE.upPop;
    this.settled = false;
    this.scatterTimer = 0.4;
  }

  /** RoomPickups.tick order: integrate, gravity, floor, bleed, settle —
   *  in ONE step per server tick with measured elapsed, not per frame.
   *  The server runs a single dt≈tick step (TickLoop passes elapsed,
   *  clamped ≤1s); per-frame stepping multiplies bleed/clamp N× more and
   *  settles ~0.5-1m off the server's rest (the nugrest spam). */
  private tumbleAcc = 0;
  /** Recent frozen-tab burst: a >0.3s frame dt means the client didn't
   *  run tumble cells the server ran in real time — rests WILL diverge
   *  by design, so the nugrest anomaly shouldn't count them. */
  private throttleBurst = false;
  private lastTickMs = 0;
  private serverTumble(dt: number, terrain: Terrain): void {
    // Wall-clock gap, not frame dt: a fully-hidden tab runs ZERO frames,
    // and a clamped dt never reaches the 0.3s trip — rests WILL diverge
    // by design after any stall, so the anomaly shouldn't count them.
    const nowMs = performance.now();
    if (dt > 0.3 || (this.lastTickMs !== 0 && nowMs - this.lastTickMs > 300)) {this.throttleBurst = true;}
    this.lastTickMs = nowMs;
    this.tumbleAcc += dt;
    if (this.settled) {this.tumbleAcc = 0; return;}
    // Fixed 50ms cells — the server steps the same grid (RoomPickups),
    // so friction bleed composes identically. A variable chunk size made
    // the bleed partition-sensitive: rests landed meters apart = nugrest.
    while (this.tumbleAcc >= 0.05) {
      this.tumbleAcc -= 0.05;
      const step = 0.05;
      const bleed = Math.max(0, 1 - NUG_TUMBLE.friction * step);
      this.prevPos.copy(this.pos);
      this.pos.addScaledVector(this.vel, step);
      this.vel.y += GRAVITY * step;
      // Same chord the server's tumble uses — getHeight is the fixed 5m
      // lattice (shared hmChord; hmHeight is the same function in shared
      // code, verified by nuggetTumble.test.ts). getRenderedHeight is
      // camera-dependent LOD, so mirroring against it diverged rests by
      // meters at range.
      const gy = terrain.getHeight(this.pos.x, this.pos.z) + NUG_TUMBLE.groundLift;
      if (this.pos.y < gy) {
        this.pos.y = gy;
        // Mirror of RoomPickups: bounce on real contact, no vy airbrake.
        this.vel.y = this.vel.y < -NUG_TUMBLE.settle ? -this.vel.y * NUG_TUMBLE.restitution : 0;
      }
      this.vel.x *= bleed; this.vel.z *= bleed;
      if (Math.abs(this.vel.x) < NUG_TUMBLE.settle && Math.abs(this.vel.y) < NUG_TUMBLE.settle && Math.abs(this.vel.z) < NUG_TUMBLE.settle) {
        this.vel.set(0, 0, 0);
        this.settled = true;
        this.tumbleAcc = 0;
        // Mirror RoomPickups.settleReachable: the server slides rests off
        // unclimbable grades before broadcasting — skipping it here left
        // the wire rest ~10-16m downhill of the predicted one (nugrest).
        const f = getHeightfield();
        if (f) {hmSettleWalkable(f, this.pos);}
        break;
      }
    }
  }

  /** Server truth for a knocked-around gem's rest spot — a correction,
   *  not a teleport: only snap when the local tumble diverged for real. */
  serverRest(p: { x: number; y: number; z: number }): void {
    if (this.collected || this.dead || !Number.isFinite(p.x + p.y + p.z)) {return;}
    parityStamp('nugrest');
    const dx = this.pos.x - p.x, dy = this.pos.y - p.y, dz = this.pos.z - p.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq < 0.5 * 0.5) {return;}
    // The predicted tumble overshot the server's rest — the "knocked it
    // and it snapped back" report. Drift under ~7m is the knock edge
    // landing mid-tumble under latency/loss (WAN runs produced ≤6.1m —
    // the headless-throttled client is the wide end). A mirror-math bug
    // diverges past that — only that class is the anomaly.
    // Throttle class: a frozen tab steps no tumble cells while the
    // server's real-time tumble ran to rest — the leftover backlog is
    // the signature (the snap itself is the designed correction).
    if (dSq > 7 * 7 && !this.throttleBurst) {parityMiss('nugrest', { dM: Math.round((dSq) ** 0.5 * 10) / 10 });}
    this.throttleBurst = false;
    this.pos.set(p.x, p.y, p.z);
    this.vel.set(0, 0, 0);
    this.settled = true;
  }

  /** Server launched (or knocked) this token: restart the shared tumble
   *  from its pos and vel. Same integrator as the server, so no correction
   *  is needed until it settles. */
  relaunch(p: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }): void {
    if (this.collected || this.dead || !Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) {return;}
    this.pos.set(p.x, p.y, p.z);
    this.prevPos.copy(this.pos);
    this.vel.set(v.x, v.y, v.z);
    this.settled = false;
    this.tumbleAcc = 0;
  }

  get atRest(): boolean { return this.settled; }

  /** Server said someone banked it — fade out where it lies; the wire
   *  burst + rewards are the caller's job. */
  serverCollect(): void {
    if (this.collected || this.dead) {return;}
    this.collected = true;
    this.collectNotified = true;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.collected || this.dead
      || !Number.isFinite(to.x + to.y + to.z + force)) {return;}
    if (this.serverOwned) {this.serverKnock(to, force, -1); return;}
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force);
    this.vel.y += Math.abs(force) * 0.4; // same pop as the server's pull branch
    this.settled = false;
    this.scatterTimer = 0.4;
  }

  private updateVisuals(dt: number): void {
    this.spinY += dt * 3;
    this.spinX += dt * 1.2;
    if (this.settled) {
      const pulse = 1 + Math.sin(this.age * 5) * 0.12;
      this.pulseColor.copy(this.emitColor).multiplyScalar(pulse);
      const y = this.renderPos.y + Math.sin(this.age * 2.5) * 0.06;
      _q.setFromEuler(_e.set(this.spinX, this.spinY, 0));
      const m = _m.compose(_target.set(this.renderPos.x, y, this.renderPos.z), _q, _s.setScalar(this.visScale * this.sizeMul));
      if (this.slot >= 0) {
        this.pools.body.mesh.setMatrixAt(this.slot, m);
        this.pools.body.mesh.instanceMatrix.needsUpdate = true;
        this.pools.body.mesh.setColorAt(this.slot, this.pulseColor.copy(this.emitColor).multiplyScalar(pulse * EMIT_GAIN));
        this.pools.body.mesh.instanceColor!.needsUpdate = true;
        if (this.pools.accent) {
          this.pools.accent.mesh.setMatrixAt(this.slot, m);
          this.pools.accent.mesh.instanceMatrix.needsUpdate = true;
          this.pools.accent.mesh.setColorAt(this.slot, this.pulseColor.copy(this.emitColor).multiplyScalar(pulse * EMIT_GAIN));
          this.pools.accent.mesh.instanceColor!.needsUpdate = true;
        }
      }
      this.writeGlow(y, 0.7 + Math.sin(this.age * 5) * 0.15);
      this.writeBeam(y);
      return;
    }
    this.writeInstance();
    // Halo stays welded to the nugget — the polygonOffset bias handles the
    // terrain-graze clip, so no visual lift needed.
    this.writeGlow(this.renderPos.y, 0.85);
    this.writeBeam(this.renderPos.y);
  }

  private writeGlow(y: number, alpha: number): void {
    if (this.glowSlot < 0) {return;}
    const c = this.emitColor;
    glowBatch(this.scene).write(this.glowSlot,
      this.renderPos.x, y, this.renderPos.z,
      2.2 * this.sizeMul * this.visScale, alpha,
      c.r * EMIT_GAIN, c.g * EMIT_GAIN, c.b * EMIT_GAIN);
  }

  private writeBeam(baseY: number): void {
    if (this.beamSlot < 0) {return;}
    const pool = beamPool(this.scene);
    _beamPos.set(this.renderPos.x, baseY + 8, this.renderPos.z);
    pool.mesh.setMatrixAt(this.beamSlot, _m.compose(_beamPos, _q.identity(), _s.set(this.sizeMul, this.visScale, this.sizeMul)));
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.mesh.setColorAt(this.beamSlot, this.emitColor);
    pool.mesh.instanceColor!.needsUpdate = true;
  }

  private emitTrail(dt: number): void {
    const speedSq = this.vel.lengthSq();
    if (speedSq <= 20) {
      this.trailTimer = 0;
      return;
    }
    this.trailTimer += dt;
    while (this.trailTimer >= TRAIL_INTERVAL) {
      this.trailTimer -= TRAIL_INTERVAL;
      this.trailFx.burst(1, this.renderPos, 0.4, this.baseColor);
    }
  }

  dispose(): void {
    glowBatch(this.scene).release(this.glowSlot);
    this.glowSlot = -1;
    releaseSlot(beamPool(this.scene), this.beamSlot);
    this.beamSlot = -1;
    if (this.slot >= 0) {
      releaseSlot(this.pools.body, this.slot);
      if (this.pools.accent) {releaseSlot(this.pools.accent, this.slot);}
      this.slot = -1;
    }
    this.trailFx.dispose();
  }
}
