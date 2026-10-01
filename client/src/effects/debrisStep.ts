import * as THREE from 'three';
import { GRAVITY, BOUNCE_Y, FRICTION_XZ, GREY_DUR, SHRINK_DUR } from '../core/config.js';
import { fxPuff } from './vfx.js';
import type { Debris, Shard } from './debris.js';

// Per-shard lifecycle: physics step, terrain bounce, trail puffs,
// greying, and post-landing shrink.

const TRAIL_INTERVAL  = 0.03; // seconds between trail emission
const TRAIL_LIFE      = 0.8;  // trail particle lifetime
const _trailPos = new THREE.Vector3();

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
        if (s.mesh) s.mesh.scale.y = 0.25; else s.flatY = 0.25;
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

    if (!s.landed) emitTrail(s, dt);
    greyShard(d, s);
    return shrinkLanded(d, s);
  }

  // Trail puffs ride the shared quarks batch â€” a kill storm used to be a
  // draw call per puff per shard per interval (the 5000+ draw-call spikes).
export function emitTrail(s: Shard, dt: number): void {
    s.trailTimer += dt;
    while (s.trailTimer >= TRAIL_INTERVAL) {
      s.trailTimer -= TRAIL_INTERVAL;
      _trailPos.set(s.x, s.y, s.z);
      fxPuff(_trailPos, {
        count: 1,
        velMin: [0, 0, 0], velMax: [0, 0, 0],
        lifeMin: TRAIL_LIFE, lifeMax: TRAIL_LIFE,
        sizeScale: s.radius * 0.4 / 0.15,
        colA: [s.cr, s.cg, s.cb], colB: [s.cr, s.cg, s.cb],
        additive: true,
        gravity: false,
      });
    }
  }

export function greyShard(d: Debris, s: Shard): void {
    const gt   = Math.min(s.elapsed / GREY_DUR, 1.0);
    const grey = s.cr * 0.299 + s.cg * 0.587 + s.cb * 0.114;
    const r = s.cr + (grey - s.cr) * gt;
    const g = s.cg + (grey - s.cg) * gt;
    const b = s.cb + (grey - s.cb) * gt;
    if (s.mat) s.mat.color.setRGB(r, g, b);
    else d.writeShardColor(s, r, g, b);
  }

export function shrinkLanded(d: Debris, s: Shard): boolean {
    if (!s.landed) return true;
    const ft = 1.0 - (s.elapsed - s.landedAt) / SHRINK_DUR;
    if (ft <= 0) {
      d.removeShard(s);
      return false;
    }
    if (s.mesh) { s.mesh.scale.setScalar(ft); }
    else { s.shrink = ft; }
    d.writeShard(s);
    return true;
  }

