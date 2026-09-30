import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { impactBurst, fxPuff, blastBurst } from './vfx.js';
import type { Terrain } from '../world/terrain.js';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  mat: THREE.MeshBasicMaterial;
  noGravity?: boolean;
  sizeScale: number; // multiplies the update-loop scale formula (explosion flash)
}

// scratch — never retained
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();

interface SpawnOpts {
  opacity?: number;
  additive?: boolean;
  depthWrite?: boolean;
  side?: THREE.Side;
  noGravity?: boolean;
  sizeScale?: number;
}

/**
 * Particle effects with a free-list pool — dead particles keep their
 * Mesh+Material and get reconfigured on the next spawn. Steady-state cost
 * while jetting/skiing is zero allocation (was ~700 allocs/sec before).
 */
interface BeamFx {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
}

export class EffectsManager {
  private scene: THREE.Scene;
  private particles: Particle[] = [];
  private pool: Particle[] = [];
  private sharedGeo: THREE.SphereGeometry;
  private sharedDiscGeo: THREE.CircleGeometry;
  private beamGeo: THREE.CylinderGeometry;
  private beams: BeamFx[] = [];
  private beamPool: BeamFx[] = [];
  private terrain: Terrain | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sharedGeo = new THREE.SphereGeometry(0.15, 8, 8);
    this.sharedDiscGeo = new THREE.CircleGeometry(0.5, 8);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  }

  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
  }

  private alloc(geo: THREE.BufferGeometry, pos: THREE.Vector3, vel: THREE.Vector3, life: number, color: THREE.Color, opts: SpawnOpts = {}): Particle {
    let p = this.pool.pop();
    if (p) {
      p.mesh.geometry = geo;
      this.scene.add(p.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({ transparent: true });
      p = { mesh: new THREE.Mesh(geo, mat), mat, vel: new THREE.Vector3(), life: 0, maxLife: 0, sizeScale: 1 };
      this.scene.add(p.mesh);
    }
    const m = p.mat;
    m.color.copy(color);
    m.opacity = opts.opacity ?? 0.7;
    m.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.depthWrite = opts.depthWrite ?? true;
    m.side = opts.side ?? THREE.FrontSide;
    p.vel.copy(vel);
    p.life = life;
    p.maxLife = life;
    p.noGravity = opts.noGravity;
    p.sizeScale = opts.sizeScale ?? 1;
    p.mesh.position.copy(pos);
    p.mesh.scale.setScalar(1);
    this.particles.push(p);
    return p;
  }

  spawnExplosion(pos: THREE.Vector3, radius: number, count: number): void {
    // Batched burst — hemisphere elv 0..π/2 (old normalized (±, +, ±) dirs),
    // HSL(0.05–0.13, 1, 0.5–0.8) ≈ the orange pair below.
    blastBurst(pos, {
      count,
      elvBase: 0, elvSpan: Math.PI / 2,
      spdMin: radius * 2, spdMax: radius * 5, vy: 0,
      lifeMin: 0.4, lifeMax: 0.9,
      sizeMin: 0.25, sizeMax: 0.5,
      gravity: GRAVITY,
      c1: [1.0, 0.5, 0.0], c2: [1.0, 0.85, 0.4],
      opacity: 0.6,
    }, true);

    // Flash sphere — sharedGeo scaled up via sizeScale in the update loop
    _c.setHex(0xffcc44);
    _v.set(0, 0, 0);
    this.alloc(this.sharedGeo, pos, _v, 0.12, _c, { opacity: 0.9, sizeScale: (radius * 0.8) / 0.15 });
  }

  // Small spark burst for bullet impacts — quarks batch now (one shared
  // draw call); the flash quad stays local, it's a single pooled mesh.
  spawnImpact(pos: THREE.Vector3, vel: THREE.Vector3): void {
    const back = vel.lengthSq() > 0 ? _v.copy(vel).normalize().negate() : _v.set(0, 1, 0);
    impactBurst(pos, vel);
    // Tiny flash at the exact hit point — quad faces along the shot direction
    _c.setHex(0xffee99);
    _v2.copy(pos).addScaledVector(back, 0.05);
    const flash = this.alloc(this.sharedDiscGeo, _v2, _v3.set(0, 0, 0), 0.06, _c, { opacity: 0.8, additive: true, depthWrite: false, side: THREE.DoubleSide });
    flash.mesh.scale.setScalar(0.5);
    flash.mesh.lookAt(_v3.copy(pos).add(back));
  }

  // Bullet pock — small dark disc pressed onto the terrain surface, shrinks
  // out over ~1s. Pooled; only stamped for actual terrain hits (a mid-air
  // mark where a ball stood would read as a floating smudge).
  spawnBulletMark(pos: THREE.Vector3): void {
    if (!this.terrain) return;
    const e = 0.4;
    const h  = this.terrain.getHeight(pos.x, pos.z);
    const hx = this.terrain.getHeight(pos.x + e, pos.z) - this.terrain.getHeight(pos.x - e, pos.z);
    const hz = this.terrain.getHeight(pos.x, pos.z + e) - this.terrain.getHeight(pos.x, pos.z - e);
    _v.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize(); // surface normal
    // Lift along the normal enough to clear surface bumps between the
    // disc's center and rim — 3cm buried edges on anything but flat ground
    _v2.set(pos.x, h, pos.z).addScaledVector(_v, 0.12);
    _c.setHex(0x14100c);
    const mark = this.alloc(this.sharedDiscGeo, _v2, _v3.set(0, 0, 0), 1.0, _c,
      { opacity: 0.7, depthWrite: false, noGravity: true, sizeScale: 0.2, side: THREE.DoubleSide });
    mark.mesh.lookAt(_v3.copy(_v2).add(_v));
  }

  // Jet contrail — NOT an exhaust cloud. Tribes-style: a thin additive
  // streak fired DOWN hard (~16m/s) so particles exit the view cone in
  // ~0.1s — looking down you see a stream leaving, not a column of fat
  // blobs you're inside of. Additive + small sizeScale so overlaps add
  // light instead of mass, and the grow-on-age update reads as streaks.
  spawnJetpack(pos: THREE.Vector3): void {
    // quarks-batched — the per-particle mesh pool stayed 1 draw call per
    // puff; now the whole stream batches with every other additive system
    _v2.copy(pos); _v2.y -= 1.1; // emit below the feet, like the old -1.1 offset
    fxPuff(_v2, {
      count: 2,
      pos: [0.15, 0, 0.15],
      velMin: [-1.25, -20, -1.25], velMax: [1.25, -14, 1.25],
      lifeMin: 0.18, lifeMax: 0.30,
      sizeScale: 0.35,
      colA: [0.3, 0.7, 1.0], colB: [0.6, 1.0, 1.0],
      additive: true,
    });
  }

  // Warp beacon trail — emits AT the beacon (spawnJetpack offsets -1.2m
  // for feet, which drags the trail under the disc). Sparks shed backward
  // with a slight sag so the arc of the flight path reads.
  spawnWarpTrail(pos: THREE.Vector3): void {
    fxPuff(pos, {
      count: 2,
      velMin: [-1, -2, -1], velMax: [1, -0.5, 1],
      lifeMin: 0.25, lifeMax: 0.40,
      colA: [0.35, 0.9, 0.95], colB: [0.35, 1.0, 0.95],
    });
  }

  spawnJumpDust(pos: THREE.Vector3): void {
    // Spawn at ground level for better visual
    const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : 0;
    const spawnY = groundY + 0.2;

    // Ring burst effect - more particles, more dramatic
    for (let i = 0; i < 16; i++) {
      _c.setRGB(0.7, 0.6, 0.45);
      const ang = (i / 16) * Math.PI * 2;
      const spd = 3 + Math.random() * 4;
      _v.set(Math.cos(ang) * spd, 1.5 + Math.random() * 2.5, Math.sin(ang) * spd);
      _v2.set(pos.x, spawnY, pos.z);
      this.alloc(this.sharedGeo, _v2, _v, 0.35 + Math.random() * 0.25, _c);
    }

    // Add a few center particles for the "poof" effect
    for (let i = 0; i < 4; i++) {
      _c.setRGB(0.8, 0.7, 0.5);
      _v.set((Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2);
      _v2.set(pos.x, spawnY, pos.z);
      this.alloc(this.sharedGeo, _v2, _v, 0.3 + Math.random() * 0.2, _c);
    }
  }

  // Bounce skill FX — cyan energy burst kicked along the launch direction
  // plus the dust ring. Directional streaks read as the redirect itself.
  spawnBounce(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : pos.y - 1.8;
    _v3.set(pos.x, Math.max(pos.y - 1.2, groundY + 0.2), pos.z); // burst at feet

    // Forward cone of bright streaks along the launch direction
    for (let i = 0; i < 18; i++) {
      const spread = 0.35 + Math.random() * 0.3;
      _v.copy(dir)
        .addScaledVector(_v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), spread)
        .normalize()
        .multiplyScalar(10 + Math.random() * 18);
      _c.setHSL(0.52 + Math.random() * 0.06, 0.9, 0.6 + Math.random() * 0.3); // cyan-white
      this.alloc(this.sharedGeo, _v3, _v, 0.25 + Math.random() * 0.3, _c,
        { opacity: 0.9, additive: true, depthWrite: false, noGravity: true });
    }

    // Small dust ring where you left the ground
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      _v.set(Math.cos(ang) * 4, 0.8 + Math.random(), Math.sin(ang) * 4);
      _c.setRGB(0.7, 0.65, 0.55);
      this.alloc(this.sharedGeo, _v3, _v, 0.3 + Math.random() * 0.2, _c, { opacity: 0.5 });
    }
  }

  spawnSkiDust(pos: THREE.Vector3, velocity: THREE.Vector3): void {
    const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : 0;
    _v2.set(pos.x, groundY + 0.3, pos.z);
    fxPuff(_v2, {
      count: 2,
      pos: [0.5, 0, 0.5],
      velMin: [-0.15, 0.1, -0.15], velMax: [0.15, 0.2, 0.15],
      shed: [-velocity.x * 0.05, 0, -velocity.z * 0.05],
      lifeMin: 0.3, lifeMax: 0.6,
      colA: [0.7, 0.65, 0.55], colB: [0.7, 0.65, 0.55],
      gravity: false,
    });
  }

  // Creature ground dust — ONE puff per call, callers emit on a distance
  // accumulator so faster movers naturally kick more. `speed` scales the
  // puff's size/opacity/upthrow; `radius` spreads it under bigger bodies.
  // A roller at speed plows a real roostertail; a grub barely puffs.
  spawnMoveDust(pos: THREE.Vector3, vel: THREE.Vector3, speed: number, radius: number): void {
    const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : 0;
    const k = Math.min(1, speed / 14); // 0=creep, 1=hauling
    const n = speed > 8 ? 2 : 1;       // fast movers shed pairs per puff
    const s = 0.55 + k * 0.15;         // shade base — rand range rides colA→colB
    const spread = 0.5 + k;            // (rand-0.5)·(1+k·2)
    _v2.set(pos.x, groundY + 0.15 + k * 0.3, pos.z);
    fxPuff(_v2, {
      count: n,
      pos: [radius * 0.8, 0, radius * 0.8],
      velMin: [-spread, 0.4 + k * 2.2, -spread],
      velMax: [spread, 0.4 + k * 2.2 + 0.6, spread],
      shed: [-vel.x * 0.06, 0, -vel.z * 0.06],
      lifeMin: 0.35 + k * 0.5, lifeMax: 0.55 + k * 0.5,
      sizeScale: 0.6 + k * 0.9,
      colA: [s, s * 0.92, s * 0.72], colB: [s + 0.2, (s + 0.2) * 0.92, (s + 0.2) * 0.72],
      gravity: false,
    });
  }

  // Flyer trail — ONE faint mote per call, callers emit on a distance
  // accumulator. A pale slipstream wisp shed behind the body: not smoke,
  // not a contrail — just enough to make fast silhouettes read motion.
  spawnFlyTrail(pos: THREE.Vector3, vel: THREE.Vector3, speed: number): void {
    const k = Math.min(1, speed / 18);
    const shade = 0.6 + k * 0.2;
    // Shed slightly back + drift down — a settling slipstream, not a jet
    fxPuff(pos, {
      count: 1,
      pos: [0.2, 0.2, 0.2],
      velMin: [-0.2, -0.3 - k * 0.4, -0.2], velMax: [0.2, -0.3 - k * 0.4, 0.2],
      shed: [-vel.x * 0.1, 0, -vel.z * 0.1],
      lifeMin: 0.5 + k * 0.6, lifeMax: 0.5 + k * 0.6,
      sizeScale: 0.35 + k * 0.4,
      colA: [shade, shade * 0.95, shade * 0.85], colB: [shade, shade * 0.95, shade * 0.85],
      gravity: false,
    });
  }

  // Hitscan beam flash (remote railgun discharge): a transient additive
  // rod from→to that fades fast. Pooled like particles — mesh+mat reused.
  spawnBeam(from: THREE.Vector3, to: THREE.Vector3, colorHex = 0x99eeff): void {
    _v.subVectors(to, from);
    const len = _v.length();
    if (len < 0.01) return;
    let b = this.beamPool.pop();
    if (!b) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      b = { mesh: new THREE.Mesh(this.beamGeo, mat), mat, life: 0, maxLife: 0 };
    }
    b.mesh.position.copy(from).addScaledVector(_v, 0.5);
    b.mesh.quaternion.setFromUnitVectors(_v3.set(0, 1, 0), _v.normalize());
    b.mesh.scale.set(0.14, len, 0.14);
    b.mat.color.setHex(colorHex);
    b.mat.opacity = 0.85;
    b.life = b.maxLife = 0.35;
    this.scene.add(b.mesh);
    this.beams.push(b);
  }

  update(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        this.beamPool.push(b);
        this.beams[i] = this.beams[this.beams.length - 1];
        this.beams.pop();
        continue;
      }
      const t = b.life / b.maxLife;
      b.mat.opacity = t * 0.85;
      b.mesh.scale.x = b.mesh.scale.z = 0.14 * (0.4 + t); // the collapse sells the discharge
    }
    const gravity = GRAVITY;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.pool.push(p); // pooled — mesh+mat reused, nothing disposed
        const last = this.particles.length - 1;
        this.particles[i] = this.particles[last];
        this.particles.pop(); // order doesn't matter — splice is O(n) shift
        continue;
      }
      const t = p.life / p.maxLife;
      p.mat.opacity = t * 0.6;
      if (!p.noGravity) {
        p.vel.y += gravity * dt;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      const s = (0.3 + t * 1.4) * p.sizeScale;
      p.mesh.scale.setScalar(s);
    }
  }
}
