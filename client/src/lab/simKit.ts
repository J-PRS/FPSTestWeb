/**
 * Sim-lab entity kit — one spawnSim() call per shared sim kind, so a
 * scenario is "spawn these real sims, move a target, collect dumps"
 * instead of per-sim mesh/step glue. Each entity wraps the production
 * sim function (shared/ballSim, creatureCore, projSim, MoveSim) and
 * owns one primitive mesh — no game classes, no pooling contracts.
 */
import * as THREE from 'three';
import { makeSimBall, stepBall, BALL_OVERSPEED, type SimBall, type BallVariant } from '../../../shared/ballSim.js';
import { makeSimCrawler, stepCrawler, commitTarget, type SimCrawler } from '../../../shared/creatureCore.js';
import { projStep, segFieldHit, type SimProjectile } from '../../../shared/projSim.js';
import { hmHeight, type Heightfield } from '../../../shared/heightfield.js';
import { GRAVITY, MoveSim, type MoveSurface } from '../../../shared/movement.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { buildProjectileMeshes, updateProjectileMesh, releaseProjectileInstance, syncProjectileInstance } from '../projectiles/visuals.js';
import { QuarksTrail } from '../effects/vfx.js';
import { Explosion } from '../effects/explosion.js';
import { hitRadiusAt } from '../../../shared/combat.js';

/** What the lab gives every entity each tick — the same things the real
 *  sims read from the world (terrain, hunt target, clock). */
export interface LabWorld {
  scene: THREE.Scene;
  field: Heightfield;
  /** Shared prey point — scenarios move it; hunters chase it. */
  target: { x: number; y: number; z: number } | null;
  time: number;
  /** Live one-shot effects (real Explosions) — entities push, labOf ticks. */
  effects: { update(dt: number): void; dead: boolean; dispose(): void }[];
}

export interface SimEntity {
  mesh: THREE.Object3D;
  tick(dt: number, world: LabWorld): void;
  /** Copy sim state → mesh. */
  sync(): void;
  /** Extra rows merged into the right pane. */
  dump?(): [string, string][];
  dispose(): void;
}

const BALL_LAB_COLORS = [0xff9a3a, 0x5ad0ff, 0x6fe3a5, 0xd98aff];

export const LAB_FLAT_FIELD: Heightfield = { size: 8, data: new Uint8Array(8 * 8), stride: 1 };

export const LAB_SURFACE: MoveSurface = {
  getHeight: (x, z) => hmHeight(LAB_FLAT_FIELD, x, z),
  getNormal: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};

/** Seeded LCG — entities share it so replays stay deterministic. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/* ---------------------------------- */

export interface BallOpts {
  id: number; variant?: BallVariant; pos: THREE.Vector3 | { x: number; y: number; z: number };
  vel?: { x: number; y: number; z: number };
  enraged?: boolean; rand?: () => number;
  /** Fires on each stepBall segment event (bounce/lunge/enrage/...). */
  onSegment?: (kind: string) => void;
}

export function spawnBall(o: BallOpts, world: LabWorld): SimEntity & { sim: SimBall } {
  const b = makeSimBall(o.id, o.variant ?? 0, o.id % 4,
    { x: o.pos.x, y: o.pos.y, z: o.pos.z },
    o.vel ?? { x: 0, y: 0, z: 0 });
  if (o.enraged) b.enraged = true;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(b.radius, 16, 16),
    new THREE.MeshBasicMaterial({ color: BALL_LAB_COLORS[o.id % BALL_LAB_COLORS.length], wireframe: b.enraged }),
  );
  mesh.position.copy(o.pos as THREE.Vector3);
  world.scene.add(mesh);
  const rand = o.rand;
  return {
    sim: b, mesh,
    tick(dt, w) {
      if (b.dead) return;
      const sp = Math.hypot(b.vx, b.vy, b.vz);
      if (sp > BALL_OVERSPEED) { const k = BALL_OVERSPEED / sp; b.vx *= k; b.vy *= k; b.vz *= k; }
      const seg = stepBall(b, dt, w.field, w.target, true, { rand });
      if (seg) o.onSegment?.(seg);
    },
    sync() { mesh.position.set(b.x, b.y, b.z); },
    dispose() { world.scene.remove(mesh); mesh.geometry.dispose(); },
  };
}

/* ---------------------------------- */

const CRAWLER_STATE_COLOR: Record<string, number> = { wander: 0x8aa0b5, chase: 0xff9a3a, windup: 0xff3355 };

export interface CrawlerOpts {
  id: number; species?: string; uber?: boolean; seed?: number;
  pos: { x: number; y: number; z: number };
  onEvent?: (ev: string) => void;
}

export function spawnCrawler(o: CrawlerOpts, world: LabWorld): SimEntity & { sim: SimCrawler } {
  const c = makeSimCrawler(o.id, o.pos, o.uber ?? false, o.seed ?? (o.id * 7919 + 3), o.species ?? 'crawler');
  const base = c.health;
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.8, 1.6, 8),
    new THREE.MeshBasicMaterial({ color: CRAWLER_STATE_COLOR.wander! }),
  );
  world.scene.add(mesh);
  return {
    sim: c, mesh,
    tick(dt, w) {
      commitTarget(c, 'prey', w.target);
      const ev = stepCrawler(c, dt, w.field, w.target, true);
      if (ev) o.onEvent?.(ev);
    },
    sync() {
      mesh.position.set(c.x, c.y + 0.8, c.z);
      mesh.rotation.y = -c.yaw;
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(
        c.dead ? 0x333a44 : CRAWLER_STATE_COLOR[c.state] ?? 0x8aa0b5);
      const k = Math.max(0.3, c.health / base);
      mesh.scale.setScalar(c.uber ? 1.6 : 0.7 + 0.3 * k);
    },
    dump: () => [['state', c.state], ['hp', `${Math.max(0, c.health).toFixed(0)}`]],
    dispose() { world.scene.remove(mesh); mesh.geometry.dispose(); },
  };
}

/* ---------------------------------- */

export interface BoltOpts {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  radius?: number; color?: number; gravity?: number; maxAge?: number;
  /** Wall planes: bolt dies when pos crosses one (lab colliders). */
  walls?: { axis: 'x' | 'y' | 'z'; at: number }[];
  /** Extra impact effect — gets the point + whether it was a wall/terrain hit. */
  onDone?: (impact: { x: number; y: number; z: number } | null) => void;
}

const BOLT_TRAIL_PTS = 12;

export function spawnBolt(o: BoltOpts, world: LabWorld): SimEntity & { sim: SimProjectile; done: boolean } {
  const p: SimProjectile = { pos: { ...o.pos }, vel: { ...o.vel }, age: 0 };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(o.radius ?? 0.3, 10, 10),
    new THREE.MeshBasicMaterial({ color: o.color ?? 0xffe08a }),
  );
  mesh.position.set(o.pos.x, o.pos.y, o.pos.z);
  world.scene.add(mesh);

  // Ribbon-lite trail: a fading line of recent positions — reads as a
  // weapon silhouette without pulling the game's batch machinery in.
  const trailGeo = new THREE.BufferGeometry();
  const trailPos = new Float32Array(BOLT_TRAIL_PTS * 3);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: o.color ?? 0xffe08a, transparent: true, opacity: 0.8 }));
  trail.frustumCulled = false;
  const history: { x: number; y: number; z: number }[] = [];
  world.scene.add(trail);

  const self: SimEntity & { sim: SimProjectile; done: boolean } = {
    sim: p, mesh, done: false,
    tick(dt, w) {
      if (self.done) return;
      const from = projStep(p, dt, o.gravity ?? GRAVITY);
      let hit = segFieldHit(from, p.pos, w.field);
      if (!hit && o.walls?.some(wall =>
        (wall.axis === 'x' ? p.pos.x : wall.axis === 'y' ? p.pos.y : p.pos.z) * Math.sign(wall.at) >= Math.abs(wall.at))) {
        hit = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      }
      if (hit || p.age > (o.maxAge ?? 30)) {
        self.done = true;
        if (hit) { p.pos.x = hit.x; p.pos.y = hit.y; p.pos.z = hit.z; }
        o.onDone?.(hit);
      }
    },
    sync() {
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      history.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
      if (history.length > BOLT_TRAIL_PTS) history.shift();
      history.forEach((h, i) => { trailPos[i * 3] = h.x; trailPos[i * 3 + 1] = h.y; trailPos[i * 3 + 2] = h.z; });
      trailGeo.attributes.position!.needsUpdate = true;
      trailGeo.setDrawRange(0, history.length);
    },
    dispose() {
      world.scene.remove(mesh, trail);
      mesh.geometry.dispose();
      trailGeo.dispose();
    },
  };
  return self;
}

/* ---------------------------------- */
/* Real-VFX shell — the production projectile VISUAL path (instanced    */
/* body mesh + glow + ribbons + quarks trail + Explosion) wrapped around */
/* a lab-driven SimProjectile. Everything rendered is what the game     */
/* renders; only the flight integrator is lab-side.                     */
/* ---------------------------------- */

export interface ShellOpts {
  weaponType: number;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  gravity?: number; maxAge?: number;
  walls?: { axis: 'x' | 'y' | 'z'; at: number }[];
  /** Custom hit channel (foe capsule, pad, ...) — return true = impact. */
  hitTest?: (from: { x: number; y: number; z: number }, pos: { x: number; y: number; z: number }) => boolean;
  /** Explosion style override; defaults to the config's own blast look. */
  blastScale?: number; tint?: number | string;
  vfx?: 'splash' | 'punch' | 'energy' | 'kinetic' | 'concussion' | 'arc' | 'bolt' | 'flak';
  onDone?: (impact: { x: number; y: number; z: number } | null, directHit: boolean) => void;
}

export function spawnShell(o: ShellOpts, world: LabWorld): SimEntity & { sim: SimProjectile; done: boolean; detonate(directHit?: boolean): void } {
  const config = getProjectileConfig(o.weaponType)!;
  const p: SimProjectile = { pos: { ...o.pos }, vel: { ...o.vel }, age: 0 };
  const pos = new THREE.Vector3(o.pos.x, o.pos.y, o.pos.z);
  const vel = new THREE.Vector3(o.vel.x, o.vel.y, o.vel.z);
  const built = buildProjectileMeshes(world.scene, config, pos);
  const trail = new QuarksTrail({ config, pos, vel, age: () => p.age });
  const tumble = { x: 0.6, y: 0.8, z: 0.4 };
  let exploded = false;

  const impactCheck = (from: { x: number; y: number; z: number }, w: LabWorld): { hit: boolean; direct: boolean } => {
    if (o.hitTest?.(from, p.pos)) return { hit: true, direct: true };
    const ground = segFieldHit(from, p.pos, w.field);
    if (ground) pos.set(ground.x, ground.y, ground.z);
    const hit = !!ground || !!o.walls?.some(wall =>
      (wall.axis === 'x' ? p.pos.x : wall.axis === 'y' ? p.pos.y : p.pos.z) * Math.sign(wall.at) >= Math.abs(wall.at))
      || p.age > (o.maxAge ?? config.maxLifetime ?? 30);
    return { hit, direct: false };
  };

  const self = {
    sim: p, mesh: built.mesh, done: false as boolean,
    detonate(directHit = false) {
      if (exploded) return;
      exploded = true;
      releaseProjectileInstance(built.mesh);
      releaseProjectileInstance(built.glowMesh);
      const st = config;
      world.effects.push(new Explosion(
        world.scene, pos, directHit, p.age,
        undefined, o.blastScale ?? 1, o.tint ?? st.meshColor, o.vfx));
      o.onDone?.({ x: pos.x, y: pos.y, z: pos.z }, directHit);
    },
    tick(dt: number, w: LabWorld) {
      if (self.done) return;
      const from = projStep(p, dt, o.gravity ?? GRAVITY);
      pos.set(p.pos.x, p.pos.y, p.pos.z);
      vel.set(p.vel.x, p.vel.y, p.vel.z);
      if (!exploded) {
        trail.emitSegment();
        updateProjectileMesh(built.mesh, built.glowMesh, pos, vel, config, p.age,
          hitRadiusAt(o.weaponType, p.age), tumble, dt);
        const impact = impactCheck(from, w);
        if (impact.hit) self.detonate(impact.direct);
      }
      for (const r of built.ribbons) r.update(dt);
      // Death waits on the visuals: an exploded shell stays until its
      // trail is empty and every ribbon has faded — same rule Projectile
      // uses, so streaks don't cut mid-fade.
      if (exploded && trail.empty && built.ribbons.every(r => r.done)) self.done = true;
    },
    sync() {
      if (!exploded) {
        syncProjectileInstance(built.mesh);
        if (built.glowMesh) syncProjectileInstance(built.glowMesh);
      }
    },
    dispose() {
      trail.dispose();
      for (const r of built.ribbons) r.dispose();
      releaseProjectileInstance(built.mesh);
      releaseProjectileInstance(built.glowMesh);
    },
  } satisfies SimEntity & { sim: SimProjectile; done: boolean; detonate(directHit?: boolean): void };
  return self;
}

/* ---------------------------------- */

export interface MoverOpts {
  pos: { x: number; y: number; z: number };
  color?: number; surface?: MoveSurface;
}

/** Real MoveSim body — the scenario scripts its input each tick via
 *  `drive(sim)`; the entity just integrates and reports. */
export function spawnMover(o: MoverOpts, world: LabWorld): SimEntity & { sim: MoveSim; drive?: (dt: number) => void } {
  const sim = new MoveSim(o.surface ?? LAB_SURFACE, {
    pos: { x: o.pos.x, y: o.pos.y, z: o.pos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: false,
  });
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.9, 1.4, 4, 12),
    new THREE.MeshBasicMaterial({ color: o.color ?? 0x6fe3a5 }),
  );
  world.scene.add(mesh);
  const self: SimEntity & { sim: MoveSim; drive?: (dt: number) => void } = {
    sim, mesh,
    tick(dt) {
      self.drive?.(dt);
      sim.update(dt);
    },
    sync() {
      const s = sim.state;
      mesh.position.set(s.pos.x, s.pos.y - 1.5, s.pos.z);
      mesh.rotation.y = s.yaw;
    },
    dump: () => {
      const s = sim.state;
      return [
        ['pos', `${s.pos.x.toFixed(0)}, ${s.pos.y.toFixed(0)}, ${s.pos.z.toFixed(0)}`],
        ['speed', Math.hypot(s.vel.x, s.vel.y, s.vel.z).toFixed(1)],
        ['onGround', String(s.onGround)],
      ];
    },
    dispose() { world.scene.remove(mesh); mesh.geometry.dispose(); },
  };
  return self;
}
