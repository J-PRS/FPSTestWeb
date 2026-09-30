import * as THREE from 'three';

import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { ProjectileConfig } from './types.js';

export interface TrailParticle {
  mesh: THREE.Mesh | THREE.Sprite;
  mat: THREE.MeshBasicMaterial | THREE.SpriteMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseSize: number;
}

const TRAIL_GEO = new THREE.SphereGeometry(1, 8, 6);
const TRAIL_RING_GEO = new THREE.RingGeometry(0.5, 1.0, 24);
const TRAIL_DISC_GEO = new THREE.CircleGeometry(1, 24);
const getTrailSpriteTex = () => getGlowTexture(64);

// Trail-emission scratches — never retained (particle.vel is the only kept ref)
const _tDir = new THREE.Vector3();
const _tArb = new THREE.Vector3();
const _tRight = new THREE.Vector3();
const _tUp = new THREE.Vector3();
const _tOff = new THREE.Vector3();
const _tPos = new THREE.Vector3();
const _tSpawn = new THREE.Vector3();
const _tLookAt = new THREE.Vector3();
const _tVel = new THREE.Vector3();

/** What the trail needs from its host projectile — nothing else. */
export interface TrailHost {
  scene: THREE.Scene;
  config: ProjectileConfig;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  age(): number;
  hitRadius(): number;
}

/**
 * Particle trail + wake-marker subsystem. Emits evenly spaced particles along
 * the swept path plus (for wakeVisual weapons) drifting markers that trace
 * the growing proxy hitbox. Dead particles are pooled — sustained fire
 * allocates once per concurrent particle, not once per emit.
 */
export class ProjectileTrail {
  private particles: TrailParticle[] = [];
  // Shared free-list per mesh type — a per-instance pool meant every
  // projectile rebuilt its trail set from scratch. Static + keyed keeps
  // sustained fire at ~zero allocation once warm.
  private static pools = new Map<string, TrailParticle[]>();
  private accum = 0; // fractional carry-over for even particle spacing

  private meshKey(): string { return this.host.config.trailMeshType ?? 'sphere'; }

  constructor(private host: TrailHost) {}

  get empty(): boolean { return this.particles.length === 0; }

  // Evenly spaced emission along prevPos→pos — spacing is in world units so
  // slow shells and fast slugs get the same particle density
  emitSegment(): void {
    const { pos, prevPos } = this.host;
    const trailDist = pos.distanceTo(prevPos);
    if (trailDist < 1e-6) return;
    const spacing = 1 / this.host.config.trailParticlesPerUnit;
    this.accum += trailDist;
    while (this.accum >= spacing) {
      this.accum -= spacing;
      const t = 1 - this.accum / trailDist;
      this.emit(_tSpawn.copy(prevPos).lerp(pos, Math.max(0, Math.min(1, t))));
    }
  }

  private emit(spawnPos: THREE.Vector3): void {
    const { config, vel } = this.host;
    const age = this.host.age();
    const dir = vel.lengthSq() > 0.0001
      ? _tDir.copy(vel).normalize()
      : _tDir.set(0, 1, 0);

    const arbitrary = _tArb.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
    const right = _tRight.crossVectors(dir, arbitrary).normalize();
    const up = _tUp.crossVectors(right, dir).normalize();

    const emitterRamp = config.trailRampIn > 0 ? Math.min(age / config.trailRampIn, 1.0) : 1.0;

    const u = (Math.random() - 0.5) * config.trailSpread * emitterRamp;
    const v = (Math.random() - 0.5) * config.trailSpread * emitterRamp;
    const w = (Math.random() - 0.5) * config.trailForwardSpread * emitterRamp;
    const offset = _tOff.set(0, 0, 0)
      .addScaledVector(right, u)
      .addScaledVector(up, v)
      .addScaledVector(dir, w);
    const pos = _tPos.copy(spawnPos).add(offset);

    // Random drift velocity — copied into the pooled particle's Vector3,
    // no allocation per emit
    _tVel.set((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);

    const life = config.trailLifeMin + Math.random() * (config.trailLifeMax - config.trailLifeMin);
    const size = (config.trailBaseSize + Math.random() * config.trailSizeRange) * emitterRamp;
    this.particles.push(this.spawn(pos, _tVel, life, size, dir));

    // Wake marker: particles scattered through the wake volume — random
    // angle, random radius out to hitRadius, dropped slightly behind the
    // shell and drifting backward+inward. Reads as a turbulent corridor
    // tracing the growing proxy hitbox, not a polka-dot halo.
    if (config.wakeVisual) {
      const r = this.host.hitRadius();
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = r * (0.55 + Math.random() * 0.45); // weighted to the edge
        const ca = Math.cos(a), sa = Math.sin(a);
        const back = Math.random() * 0.6; // lag behind the shell
        _tPos.copy(spawnPos)
          .addScaledVector(right, ca * rad)
          .addScaledVector(up, sa * rad)
          .addScaledVector(dir, -back);
        _tVel.set(
          -ca * 0.9 * right.x - sa * 0.9 * up.x - dir.x * 1.5,
          -ca * 0.9 * right.y - sa * 0.9 * up.y - dir.y * 1.5,
          -ca * 0.9 * right.z - sa * 0.9 * up.z - dir.z * 1.5
        );
        // Size tracks hitRadius — the corridor visibly widens as the
        // projectile's proxy hitbox grows over hitGrow seconds
        this.particles.push(this.spawn(
          _tPos, _tVel,
          0.12 + Math.random() * 0.12,
          config.trailBaseSize * (0.4 + r * 0.3),
          dir
        ));
      }
    }
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, dir: THREE.Vector3): TrailParticle {
    const { config, scene } = this.host;
    const meshType = config.trailMeshType ?? 'sphere';

    // Reuse a dead particle's mesh+material — pooled per meshType
    const pool = ProjectileTrail.pools.get(this.meshKey());
    const pooled = pool?.pop();
    if (pooled) {
      pooled.vel.copy(vel);
      pooled.life = life;
      pooled.maxLife = life;
      pooled.baseSize = size;
      pooled.mat.color.copy(config.trailColors[0]);
      pooled.mat.opacity = config.trailOpacity;
      pooled.mesh.position.copy(pos);
      pooled.mesh.scale.setScalar(meshType === 'billboard' ? size * 2 : size);
      if (meshType === 'ring' || meshType === 'disc') {
        pooled.mesh.rotation.set(0, 0, 0);
        pooled.mesh.lookAt(_tLookAt.copy(pos).add(dir));
        if (meshType === 'disc') pooled.mesh.rotateX(Math.PI / 2);
      }
      scene.add(pooled.mesh);
      return pooled;
    }

    if (meshType === 'billboard') {
      // Sprite auto-faces the camera — visible even shooting straight ahead
      const mat = new THREE.SpriteMaterial({
        map: getTrailSpriteTex(),
        color: new THREE.Color(config.trailColors[0]).multiplyScalar(EMIT_GAIN),
        transparent: true,
        opacity: config.trailOpacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Sprite(mat);
      mesh.layers.enable(BLOOM_LAYER);
      mesh.position.copy(pos);
      mesh.scale.setScalar(size * 2);
      scene.add(mesh);
      return { mesh, mat, vel: vel.clone(), life, maxLife: life, baseSize: size };
    }

    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(config.trailColors[0]).multiplyScalar(EMIT_GAIN),
      transparent: true,
      opacity: config.trailOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    let geo: THREE.BufferGeometry;
    if (meshType === 'ring') {
      geo = TRAIL_RING_GEO;
    } else if (meshType === 'disc') {
      geo = TRAIL_DISC_GEO;
    } else {
      geo = TRAIL_GEO;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.enable(BLOOM_LAYER);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    if (meshType === 'ring') {
      mesh.lookAt(_tLookAt.copy(pos).add(dir));
    } else if (meshType === 'disc') {
      // For frisbee-style trail: orient disc sideways (perpendicular to
      // velocity) so it looks like a spinning disc trail
      mesh.lookAt(_tLookAt.copy(pos).add(dir));
      mesh.rotateX(Math.PI / 2);
    }
    scene.add(mesh);
    return { mesh, mat, vel: vel.clone(), life, maxLife: life, baseSize: size };
  }

  update(dt: number): void {
    const { config, scene } = this.host;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        scene.remove(p.mesh);
        const pool = ProjectileTrail.pools.get(this.meshKey())
          ?? ProjectileTrail.pools.set(this.meshKey(), []).get(this.meshKey())!;
        pool.push(p); // keep mesh+mat for reuse across projectiles
        this.particles.splice(i, 1);
        continue;
      }
      const t = p.life / p.maxLife;
      const ft = 1 - t;

      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.y += config.trailParticleGravity * dt;

      const colors = config.trailColors;
      const gradientT = ft;
      const colorIdx = gradientT * (colors.length - 1);
      const idx0 = Math.floor(colorIdx);
      const idx1 = Math.min(idx0 + 1, colors.length - 1);
      const blend = colorIdx - idx0;
      const c0 = colors[idx0];
      const c1 = colors[idx1];
      p.mat.color.setRGB(
        c0.r + (c1.r - c0.r) * blend,
        c0.g + (c1.g - c0.g) * blend,
        c0.b + (c1.b - c0.b) * blend
      );

      p.mat.opacity = t * config.trailOpacity;
      p.mesh.scale.setScalar(p.baseSize * (config.trailScaleMin + (config.trailScaleMax - config.trailScaleMin) * ft));
    }
  }

  dispose(): void {
    const scene = this.host.scene;
    const pool = ProjectileTrail.pools.get(this.meshKey())
      ?? ProjectileTrail.pools.set(this.meshKey(), []).get(this.meshKey())!;
    // Still-live particles go back to the shared pool — the pool now
    // outlives the projectile, so materials must NOT be disposed here.
    for (const p of this.particles) {
      scene.remove(p.mesh);
      pool.push(p);
    }
    this.particles.length = 0;
  }
}
