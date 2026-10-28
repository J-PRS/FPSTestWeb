import * as THREE from 'three';
import { GRAVITY, BOUNCE_Y, FRICTION_XZ, GREY_DUR, SHRINK_DUR } from '../core/config.js';
import { BallTrailDots } from './ballTrails.js';
import { fxPuff } from './vfx.js';
import { SMOKE_INTERVAL } from './debrisShards.js';
import type { Debris, Shard } from './debris.js';

// Per-shard lifecycle: physics step, terrain bounce, trail puffs,
// greying, and post-landing shrink.

const TRAIL_INTERVAL  = 0.06; // seconds between trail dots (14-dot slot ≈ 0.8s of trail)

const _trailPos = new THREE.Vector3();
const _trailTint = new THREE.Color();

export function shrinkLanded(d: Debris, s: Shard): boolean {
    if (!s.landed) {return true;}
    const ft = 1 - (s.elapsed - s.landedAt) / SHRINK_DUR;
    if (ft <= 0) {
      d.removeShard(s);
      return false;
    }
    if (s.mesh) { s.mesh.scale.setScalar(ft); }
    else { s.shrink = ft; }
    d.writeShard(s);
    return true;
  }



export function greyShard(d: Debris, s: Shard): void {
    const gt   = Math.min(s.elapsed / GREY_DUR, 1);
    const grey = s.cr * 0.299 + s.cg * 0.587 + s.cb * 0.114;
    const r = s.cr + (grey - s.cr) * gt;
    const g = s.cg + (grey - s.cg) * gt;
    const b = s.cb + (grey - s.cb) * gt;
    if (s.mat) {s.mat.color.setRGB(r, g, b);}
    else {d.writeShardColor(s, r, g, b);}
  }



// Smoke wake for player gibs — one pooled fxPuff wisp per shard on a
// slow cadence, only while still moving fast enough to read as "flung".
// Dark alpha puffs (not additive) shed against velocity so the trail
// leans back along the flight path. fxPuff pressure-throttles itself,
// so a multi-kill storm degrades density before it costs frames.
export function emitSmoke(d: Debris, s: Shard, dt: number): void {
    if (!d.smoke) {return;}
    s.smokeTimer += dt;
    if (s.smokeTimer < SMOKE_INTERVAL) {return;}
    s.smokeTimer = 0;
    if (s.vx * s.vx + s.vy * s.vy + s.vz * s.vz < 25) {return;} // <5m/s: wisps stop
    _trailPos.set(s.x, s.y, s.z);
    fxPuff(_trailPos, {
      count: 2,
      velMin: [-0.3, 0.3, -0.3], velMax: [0.3, 1, 0.3],
      shed: [-s.vx * 0.1, -s.vy * 0.05, -s.vz * 0.1],
      lifeMin: 0.5, lifeMax: 0.9,
      sizeScale: Math.max(0.6, s.radius * 2),
      colA: [0.16, 0.15, 0.14], colB: [0.3, 0.28, 0.26],
      gravity: false,
    });
  }



  // Trail dots ride the shared BallTrailDots batch â€” a kill storm used to be a
  // draw call per puff per shard per interval (the 5000+ draw-call spikes).
  // Trail dots ride the shared BallTrailDots Points batch — one slot per
  // airborne shard, ~128 trails per draw call. The quarks puff this
  // replaced built a whole ParticleSystem per emission: a few hundred
  // airborne shards × 33Hz churned thousands of live systems (the 3338-
  // live-systems frame tank).
export function emitTrail(d: Debris, s: Shard, dt: number): void {
    s.trail ??= new BallTrailDots(d.scene, { interval: TRAIL_INTERVAL, opacity: 0.6 });
    s.trail.fade(dt);
    s.trailTimer += dt;
    while (s.trailTimer >= TRAIL_INTERVAL) {
      s.trailTimer -= TRAIL_INTERVAL;
      _trailPos.set(s.x, s.y, s.z);
      s.trail.burst(1, _trailPos, s.radius * 0.8, _trailTint.setRGB(s.cr, s.cg, s.cb));
    }
  }



  // Returns false when the shard has fully shrunk away after landing
export function stepShard(d: Debris, s: Shard, dt: number): boolean {
    // Physics â€” brush shards flutter: light gravity, air drag, soft bounce
    s.vy += GRAVITY * (s.brush ? 0.3 : 1) * dt;
    if (s.brush) {
      const drag = 1 - 1.2 * dt;
      s.vx *= drag; s.vz *= drag;
    }
    s.x  += s.vx * dt;
    s.y  += s.vy * dt;
    s.z  += s.vz * dt;

    // Terrain bounce
    const gy = d.terrain.getHeightVisual(s.x, s.z);
    if (s.y - s.radius <= gy) {
      s.y   = gy + s.radius;
      if (s.goo) {
        // Splat â€” sticks where it lands, flattens, shrinks away fast
        s.vy = 0; s.vx *= 0.1; s.vz *= 0.1;
        if (s.mesh) {s.mesh.scale.y = 0.25;} else {s.flatY = 0.25;}
        if (!s.landed) {d.paintShard(s);} // the droplet's ground kiss paints the stain
      } else {
        s.vy  = -s.vy * (s.brush ? 0.25 : BOUNCE_Y); // twigs flop, not bounce
        s.vx *= FRICTION_XZ;
        s.vz *= FRICTION_XZ;
      }
      s.rx *= 0.3; s.ry *= 0.3; s.rz *= 0.3;
      if (!s.landed) { s.landed = true; s.landedAt = s.elapsed; }
    }

    if (s.mesh) {
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.rotation.x += s.rx * dt;
      s.mesh.rotation.y += s.ry * dt;
      s.mesh.rotation.z += s.rz * dt;
    } else {
      s.ex += s.rx * dt;
      s.ey += s.ry * dt;
      s.ez += s.rz * dt;
      d.writeShard(s);
    }

    if (!s.landed) { emitTrail(d, s, dt); emitSmoke(d, s, dt); }
    else if (s.trail) {
      // Touchdown stops emission but the trail still owes its dots a
      // fade-out — once drained, hand the shared slot back.
      s.trail.fade(dt);
      if (s.trail.size === 0) { s.trail.dispose(); s.trail = undefined; }
    }
    greyShard(d, s);
    return shrinkLanded(d, s);
  }

