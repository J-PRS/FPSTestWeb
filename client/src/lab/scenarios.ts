/**
 * Sim-lab scenario registry — each entry drives a slice of the shared
 * deterministic sims (shared/ballSim, projSim, movement) inside the lab's
 * own scene. Scenarios own their meshes: create() adds them, dispose()
 * removes them. Nothing here touches the game world, so a buggy or
 * expensive scenario can only ever hurt the lab view.
 */
import * as THREE from 'three';
import { segPointDist, projStep, segFieldHit, type SimProjectile } from '../../../shared/projSim.js';
import { hmHeight, hmNormal, type Heightfield } from '../../../shared/heightfield.js';
import { GRAVITY, type MoveSurface } from '../../../shared/movement.js';
import type { BallVariant } from '../../../shared/ballSim.js';
import type { BotVec } from '../../../shared/botBrain.js';
import { getWeaponStats, WeaponType } from '../../../shared/weapons.js';
import { BOT_LOADOUTS, type BotLoadout } from '../../../shared/botLoadouts.js';
import {
  spawnBall, spawnCrawler, spawnFlyer, spawnRoller, spawnSlither,
  spawnBaneling, spawnTotem,
  spawnBolt, spawnMover, spawnShell,
  LAB_FLAT_FIELD, type LabWorld, type SimEntity, type MoverOpts,
} from './simKit.js';
import {
  BOT_ENERGY_MAX, BOT_HP, botSpeed, locomoteAgent, pickAtRange,
  respawnAgent, spawnAgent, type BotAgent,
} from './botAgents.js';
import { flagScrim } from './flagScrim.js';
import { getProjectileConfig } from '../projectiles/index.js';

export interface LabInstance {
  /** Advance the sim one fixed step. The view calls this at 60Hz. */
  tick(dt: number): void;
  /** Copy sim state into the meshes. Runs once per rendered frame. */
  sync(): void;
  /** Rows for the right-hand state pane. */
  dump(): [string, string][];
  /** Remove meshes + listeners. Called on scenario switch and close. */
  dispose(): void;
}

export interface LabScenario {
  id: string;
  name: string;
  blurb: string;
  create(scene: THREE.Scene): LabInstance;
}

// Flat field at y=0 — shared lab terrain so every sim runs the same
// ground code the server does, just on a plane instead of the map.
const FLAT = LAB_FLAT_FIELD;

/** Seeded LCG — scenarios pass it as StepWorld.rand so every run replays
 *  identically (teleport rolls included). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/** Scenario boilerplate: run a shared world, tick each entity, merge dumps.
 *  Adding a new sim = one spawnX call; the entity owns its step + mesh. */
function labOf(entities: SimEntity[], world: LabWorld, extra?: Partial<LabInstance>): LabInstance {
  return {
    tick(dt) {
      world.time += dt;
      extra?.tick?.(dt);
      for (const e of entities) e.tick(dt, world);
      for (let i = world.effects.length - 1; i >= 0; i--) {
        const fx = world.effects[i]!;
        fx.update(dt);
        if (fx.dead) { fx.dispose(); world.effects.splice(i, 1); }
      }
    },
    sync() { for (const e of entities) e.sync(); },
    dump() {
      const rows = extra?.dump?.() ?? [];
      for (const e of entities) if (e.dump) rows.push(...e.dump());
      return rows;
    },
    dispose() {
      for (const e of entities) e.dispose();
      for (const fx of world.effects) fx.dispose();
      world.effects.length = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ball court — free bounce around an arena, one enraged hunter.       */
/* ------------------------------------------------------------------ */

function ballCourt(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 1.5, z: 0 }, time: 0, effects: [] };
  const targetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd24d }),
  );
  scene.add(targetMesh);

  const rand = lcg(0x5eed);
  const SEG_COUNTS = new Map<string, number>();
  const balls = Array.from({ length: 5 }, (_, i) => {
    const a = (i / 5) * Math.PI * 2;
    return spawnBall({
      id: i,
      variant: (i % 4) as BallVariant,
      pos: { x: Math.cos(a) * 18, y: 12 + i * 4, z: Math.sin(a) * 18 },
      vel: { x: -Math.sin(a) * 8, y: 0, z: Math.cos(a) * 8 },
      enraged: i === 0,
      rand,
      onSegment: k => SEG_COUNTS.set(k, (SEG_COUNTS.get(k) ?? 0) + 1),
    }, world);
  });

  const hunter = balls[0]!.sim;
  const lab = labOf(balls, world, {
    dump() {
      const rows: [string, string][] = [
        ['balls', String(balls.filter(x => !x.sim.dead).length)],
        ['enraged', String(balls.filter(x => x.sim.enraged).length)],
        ['hunter pos', `${hunter.x.toFixed(1)}, ${hunter.y.toFixed(1)}, ${hunter.z.toFixed(1)}`],
        ['hunter spd', Math.hypot(hunter.vx, hunter.vy, hunter.vz).toFixed(1)],
      ];
      for (const [k, n] of SEG_COUNTS) rows.push([`seg:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.4) * 20;
    world.target!.z = Math.sin(world.time * 0.4) * 20;
    baseSync();
    targetMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(targetMesh); targetMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Mortar volley — arcing shells between two pads, terrain impacts.    */
/* ------------------------------------------------------------------ */

function mortarVolley(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: null, time: 0, effects: [] };
  const padGeo = new THREE.CylinderGeometry(2, 2, 0.4, 16);
  const padA = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: 0x3aa7ff }));
  const padB = new THREE.Mesh(padGeo.clone(), new THREE.MeshBasicMaterial({ color: 0xff7a3a }));
  padA.position.set(-40, 0, 0);
  padB.position.set(40, 0, 0);
  scene.add(padA, padB);

  const impactMat = new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.7 });
  const impacts: { m: THREE.Mesh; t: number }[] = [];
  const shells: (ReturnType<typeof spawnBolt>)[] = [];
  let side = 0, fired = 0, landed = 0, cd = 0;

  const launch = () => {
    const from = side === 0 ? padA.position : padB.position;
    const to = side === 0 ? padB.position : padA.position;
    side ^= 1;
    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    // 45° lob: range = v²/g → v = sqrt(dist*g); aim flat, let gravity arc.
    const v = Math.sqrt(dist * -GRAVITY);
    const shell = spawnBolt({
      pos: { x: from.x, y: from.y + 1, z: from.z },
      vel: { x: (dx / dist) * v * Math.SQRT1_2, y: v * Math.SQRT1_2, z: (dz / dist) * v * Math.SQRT1_2 },
      radius: 0.5,
      color: side === 1 ? 0xffe08a : 0x9adcff,
      onDone(hit) {
        landed++;
        if (hit) {
          const m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), impactMat);
          m.position.set(hit.x, hit.y + 0.5, hit.z);
          scene.add(m);
          impacts.push({ m, t: 0 });
        }
      },
    }, world);
    shells.push(shell);
    fired++;
  };

  return {
    tick(dt) {
      world.time += dt;
      cd -= dt;
      if (cd <= 0) { launch(); cd = 1.1; }
      for (const s of shells) s.tick(dt, world);
      for (let i = impacts.length - 1; i >= 0; i--) {
        const im = impacts[i]!;
        im.t += dt;
        im.m.scale.setScalar(1 + im.t * 6);
        if (im.t > 0.6) { scene.remove(im.m); im.m.geometry.dispose(); impacts.splice(i, 1); }
      }
    },
    sync() { for (const s of shells) s.sync(); },
    dump() {
      return [
        ['shells in air', String(shells.filter(s => !s.done).length)],
        ['fired', String(fired)],
        ['landed', String(landed)],
      ];
    },
    dispose() {
      for (const s of shells) s.dispose();
      for (const im of impacts) { scene.remove(im.m); im.m.geometry.dispose(); }
      scene.remove(padA, padB);
      padGeo.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Duel — two fighters drift and trade flat shots; segPointDist hits.  */
/* ------------------------------------------------------------------ */

const DUEL_SPEED = 120;
const DUEL_HP = 100;

function duel(scene: THREE.Scene): LabInstance {
  interface Fighter {
    pos: THREE.Vector3; vel: THREE.Vector3;
    hp: number; mesh: THREE.Mesh; flash: number; cd: number;
    wanderA: number;
  }
  const mkFighter = (color: number, x: number, z: number): Fighter => {
    const m = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.9, 1.4, 4, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.position.set(x, 1.6, z);
    scene.add(m);
    return { pos: m.position, vel: new THREE.Vector3(), hp: DUEL_HP, mesh: m, flash: 0, cd: 0.4, wanderA: x };
  };
  const a = mkFighter(0x5ad0ff, -22, 0);
  const b = mkFighter(0xff6a4d, 22, 0);
  const rand = lcg(0xabc1);

  const tracerGeo = new THREE.SphereGeometry(0.22, 8, 8);
  const tracerPool: THREE.Mesh[] = [];
  interface Bolt { p: SimProjectile; m: THREE.Mesh; from: Fighter }
  const bolts: Bolt[] = [];
  let shots = 0, hits = 0, deaths = 0;

  const fire = (f: Fighter, foe: Fighter) => {
    // Aim with trivial lead: close-range flat shot, vel foe moves.
    const tof = f.pos.distanceTo(foe.pos) / DUEL_SPEED;
    const aim = _aim.copy(foe.pos).addScaledVector(foe.vel, tof);
    const dir = aim.sub(f.pos).normalize();
    const m = tracerPool.pop() ?? new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xfff3a0 }));
    m.visible = true;
    scene.add(m);
    bolts.push({ p: { pos: { x: f.pos.x, y: f.pos.y, z: f.pos.z }, vel: { x: dir.x * DUEL_SPEED, y: dir.y * DUEL_SPEED, z: dir.z * DUEL_SPEED }, age: 0 }, m, from: f });
    shots++;
  };

  const _aim = new THREE.Vector3();
  return {
    tick(dt) {
      for (const f of [a, b]) {
        // Drift on a slow wander circle — keeps the duel visually alive
        // without needing the full BotBrain wiring for a lab viewer.
        f.wanderA += dt * (0.25 + rand() * 0.1);
        const cx = Math.cos(f.wanderA) * 18;
        const cz = Math.sin(f.wanderA) * 18;
        f.vel.set((cx - f.pos.x) * 0.8, 0, (cz - f.pos.z) * 0.8);
        f.pos.addScaledVector(f.vel, dt);
        f.pos.y = 1.6;
        f.cd -= dt;
        f.flash = Math.max(0, f.flash - dt * 4);
        (f.mesh.material as THREE.MeshBasicMaterial).color.setHex(f.flash > 0 ? 0xffffff : (f === a ? 0x5ad0ff : 0xff6a4d));
      }
      if (a.cd <= 0 && b.hp > 0) { fire(a, b); a.cd = 0.6 + rand() * 0.3; }
      if (b.cd <= 0 && a.hp > 0) { fire(b, a); b.cd = 0.7 + rand() * 0.3; }

      for (let i = bolts.length - 1; i >= 0; i--) {
        const bolt = bolts[i]!;
        const from = projStep(bolt.p, dt, 0);
        const foe = bolt.from === a ? b : a;
        if (segPointDist(from, bolt.p.pos, { x: foe.pos.x, y: foe.pos.y, z: foe.pos.z }) < 1.4) {
          foe.hp -= 20;
          foe.flash = 1;
          hits++;
          tracerPool.push(bolt.m); bolt.m.visible = false;
          bolts.splice(i, 1);
          if (foe.hp <= 0) {
            deaths++;
            foe.hp = DUEL_HP;
            // Respawn across the arena — the fight continues forever.
            foe.pos.set((rand() - 0.5) * 40, 1.6, (rand() - 0.5) * 40);
          }
          continue;
        }
        if (bolt.p.age > 2 || segFieldHit(from, bolt.p.pos, FLAT)) {
          tracerPool.push(bolt.m); bolt.m.visible = false;
          bolts.splice(i, 1);
        }
      }
    },
    sync() {
      for (const bolt of bolts) bolt.m.position.set(bolt.p.pos.x, bolt.p.pos.y, bolt.p.pos.z);
    },
    dump() {
      return [
        ['A hp', String(Math.max(0, a.hp))],
        ['B hp', String(Math.max(0, b.hp))],
        ['shots', String(shots)],
        ['hits', String(hits)],
        ['hit rate', shots ? `${((hits / shots) * 100).toFixed(0)}%` : '-'],
        ['deaths', String(deaths)],
        ['bolts live', String(bolts.length)],
      ];
    },
    dispose() {
      for (const f of [a, b]) { scene.remove(f.mesh); f.mesh.geometry.dispose(); }
      for (const bolt of bolts) scene.remove(bolt.m);
      tracerGeo.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Crawler pack — real creatureSim: wander/chase/windup/pounce on a    */
/* committed prey point. Shows the same stepCrawler the server runs.   */
/* ------------------------------------------------------------------ */

function crawlerPack(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 0.5, z: 0 }, time: 0, effects: [] };
  const events = new Map<string, number>();
  const pack = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return spawnCrawler({
      id: i, species: i % 2 ? 'scarab' : 'crawler', uber: i === 0,
      pos: { x: Math.cos(a) * 25, y: 0, z: Math.sin(a) * 25 },
      onEvent: ev => events.set(ev, (events.get(ev) ?? 0) + 1),
    }, world);
  });

  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const lab = labOf(pack, world, {
    dump() {
      const rows: [string, string][] = [
        ['pack', String(pack.filter(p => !p.sim.dead).length)],
        ['chasing', String(pack.filter(p => p.sim.state === 'chase').length)],
        ['winding up', String(pack.filter(p => p.sim.state === 'windup').length)],
        ['wandering', String(pack.filter(p => p.sim.state === 'wander').length)],
      ];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.3) * 18;
    world.target!.z = Math.sin(world.time * 0.5) * 18;
    baseSync();
    preyMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(preyMesh); preyMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Flyer ring — real creatureFlyer: rakks/gnats orbit the prey anchor,  */
/* telegraph, dive, climb. Same stepFlyer the server runs.             */
/* ------------------------------------------------------------------ */

function flyerRing(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 0.5, z: 0 }, time: 0, effects: [] };
  const events = new Map<string, number>();
  const flock = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return spawnFlyer({
      id: i, species: i % 3 === 2 ? 'gnat' : 'rakk', uber: i === 0,
      pos: { x: Math.cos(a) * 30, y: 14, z: Math.sin(a) * 30 },
      onEvent: ev => events.set(ev, (events.get(ev) ?? 0) + 1),
    }, world);
  });

  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const lab = labOf(flock, world, {
    dump() {
      const rows: [string, string][] = [
        ['flock', String(flock.filter(f => !f.sim.dead).length)],
        ['orbiting', String(flock.filter(f => f.sim.state === 'orbit').length)],
        ['diving', String(flock.filter(f => f.sim.state === 'dive').length)],
        ['climbing', String(flock.filter(f => f.sim.state === 'climb').length)],
      ];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.25) * 16;
    world.target!.z = Math.sin(world.time * 0.4) * 16;
    baseSync();
    preyMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(preyMesh); preyMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Species pack — every ground family hunting one prey point at once:   */
/* crawlers + scarabs, a roller, snakes. Same committed-target contract. */
/* ------------------------------------------------------------------ */

function speciesPack(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 0.5, z: 0 }, time: 0, effects: [] };
  const events = new Map<string, number>();
  const onEvent = (ev: string) => events.set(ev, (events.get(ev) ?? 0) + 1);
  const pack: SimEntity[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    pack.push(spawnCrawler({ id: i, species: 'crawler', pos: { x: Math.cos(a) * 25, y: 0, z: Math.sin(a) * 25 }, onEvent }, world));
  }
  for (let i = 0; i < 2; i++) {
    pack.push(spawnRoller({ id: 10 + i, pos: { x: -30 + i * 8, y: 0, z: -20 }, onEvent }, world));
    pack.push(spawnSlither({ id: 20 + i, pos: { x: 30 - i * 8, y: 0, z: 20 }, onEvent }, world));
  }

  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const lab = labOf(pack, world, {
    dump() {
      const rows: [string, string][] = [['pack', String(pack.length)]];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.3) * 18;
    world.target!.z = Math.sin(world.time * 0.5) * 18;
    baseSync();
    preyMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(preyMesh); preyMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Totem field — real creatureTotem: aim → charge (locked line shows)   */
/* → fire → blink relocate. The beam drawn is the sim's committed lock. */
/* ------------------------------------------------------------------ */

function totemField(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 0.5, z: 0 }, time: 0, effects: [] };
  const events = new Map<string, number>();
  const onEvent = (ev: string) => events.set(ev, (events.get(ev) ?? 0) + 1);
  const totems = [
    spawnTotem({ id: 1, pos: { x: -20, y: 0, z: -10 }, onEvent }, world),
    spawnTotem({ id: 2, pos: { x: 22, y: 0, z: -6 }, onEvent }, world),
    spawnTotem({ id: 3, pos: { x: 0, y: 0, z: 26 }, uber: true, onEvent }, world),
  ];

  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const lab = labOf(totems, world, {
    dump() {
      const rows: [string, string][] = [
        ['totems', String(totems.length)],
        ['charging', String(totems.filter(t => t.sim.state === 'charge').length)],
        ['shots', String(totems.reduce((n, t) => n + t.sim.shotsFired, 0))],
      ];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.3) * 14;
    world.target!.z = Math.sin(world.time * 0.45) * 14;
    baseSync();
    preyMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(preyMesh); preyMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Baneling rush — real creatureBaneling: fuse-lit charge at the prey,  */
/* pop events counted as they go off.                                   */
/* ------------------------------------------------------------------ */

function banelingRush(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: { x: 0, y: 0.5, z: 0 }, time: 0, effects: [] };
  const events = new Map<string, number>();
  const onEvent = (ev: string) => events.set(ev, (events.get(ev) ?? 0) + 1);
  const pack = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2;
    return spawnBaneling({
      id: i, uber: i === 0,
      pos: { x: Math.cos(a) * 28, y: 0, z: Math.sin(a) * 28 },
      onEvent,
    }, world);
  });

  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const lab = labOf(pack, world, {
    dump() {
      const rows: [string, string][] = [
        ['pack', String(pack.filter(b => !b.sim.dead).length)],
        ['chasing', String(pack.filter(b => b.sim.state === 'chase').length)],
      ];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
  });
  const baseSync = lab.sync.bind(lab);
  lab.sync = () => {
    world.target!.x = Math.cos(world.time * 0.35) * 15;
    world.target!.z = Math.sin(world.time * 0.5) * 15;
    baseSync();
    preyMesh.position.set(world.target!.x, world.target!.y, world.target!.z);
  };
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(preyMesh); preyMesh.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Ski run — real MoveSim on a steep heightfield hill, scripted input:  */
/* hold forward + ski on descents, jet bursts on climbs.               */
/* ------------------------------------------------------------------ */

// A heightfield carrying one real hill so the skier gets genuine terrain
// to read: 64x64 bump centered on (32,32) → world ~(750,0) at 1500m scale.
function makeHill(): Heightfield {
  const N = 64;
  const data = new Uint8Array(N * N);
  const R = 10;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const dx = x - 32, dz = z - 32;
      const r = Math.hypot(dx, dz);
      if (r < R) data[z * N + x] = Math.round(255 * Math.cos((r / R) * Math.PI * 0.5));
    }
  }
  return { size: N, data, stride: 1 };
}

const HILL = makeHill();
// World coords of the hill top — hmHeight wraps at 1500m, so cell (32,32)
// sits at wx = (32.5/64)*1500 ≈ 762.
const HILL_X = (32.5 / 64) * 1500;
const HILL_Z = (32.5 / 64) * 1500;

function skiRun(scene: THREE.Scene): LabInstance {
  const surface: MoveSurface = {
    getHeight: (x, z) => hmHeight(HILL, x, z),
    getNormal: (x, z, out) => { hmNormal(HILL, x, z, out); return out; },
  };
  const startY = hmHeight(HILL, HILL_X, HILL_Z);
  const world: LabWorld = { scene, field: HILL, target: null, time: 0, effects: [] };

  const mover = spawnMover({
    pos: { x: HILL_X, y: startY + 2, z: HILL_Z },
    surface,
  } satisfies MoverOpts, world);
  const sim = mover.sim;

  // Terrain ghost — a low-res wireframe of the lab-heightfield so the
  // slope the sim reads is actually visible.
  const SEG = 24, EXT = 130;
  const gpos = new Float32Array(SEG * SEG * 6 * 3);
  const terrain = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x2a4a63, wireframe: true }),
  );
  {
    let w = 0;
    for (let i = 0; i < SEG; i++) {
      for (let j = 0; j < SEG; j++) {
        const x0 = HILL_X - EXT + (i / SEG) * 2 * EXT;
        const x1 = HILL_X - EXT + ((i + 1) / SEG) * 2 * EXT;
        const z0 = HILL_Z - EXT + (j / SEG) * 2 * EXT;
        const z1 = HILL_Z - EXT + ((j + 1) / SEG) * 2 * EXT;
        const h00 = hmHeight(HILL, x0, z0), h10 = hmHeight(HILL, x1, z0);
        const h01 = hmHeight(HILL, x0, z1), h11 = hmHeight(HILL, x1, z1);
        const q = [x0, h00, z0, x1, h10, z0, x0, h01, z1, x0, h01, z1, x1, h10, z0, x1, h11, z1];
        gpos.set(q, w); w += 18;
      }
    }
    terrain.geometry.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  }
  scene.add(terrain);

  let jets = 0, runs = 0;
  const _n = { x: 0, y: 1, z: 0 };
  mover.drive = dt => {
    const s = sim.state;
    // Steer toward the local downhill — same read a skier's eyes do:
    // probe the normal; downhill is -grad ≈ (nx,0,nz) of the surface normal.
    surface.getNormal(s.pos.x, s.pos.z, _n);
    const downX = _n.x, downZ = _n.z;
    const dl = Math.hypot(downX, downZ);
    if (dl > 0.02) s.yaw = Math.atan2(-downX / dl, -downZ / dl);
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    sim.setInput({
      forward: 1,
      skiHeld: s.onGround && speed > 5,
      // Scripted jet: burn when speed bleeds off or the face turns uphill.
      jetHeld: speed < 12 || (dl > 0.02 && _n.y > 0.99 && speed < 20),
      jumpHeld: false,
      jumpPressed: false,
      right: 0,
    });
    if (sim.input.jetHeld) jets += dt;
    // Respawn at the top once the run flattens out — the lab loops forever.
    if (s.pos.y < 3 && speed < 4) {
      sim.setState({
        pos: { x: HILL_X, y: startY + 2, z: HILL_Z },
        vel: { x: 0, y: 0, z: 0 }, yaw: s.yaw, pitch: 0, onGround: false,
      });
      runs++;
    }
  };

  const lab = labOf([mover], world, {
    dump: () => [
      ['yaw', sim.state.yaw.toFixed(2)],
      ['jet time', `${jets.toFixed(1)}s`],
      ['runs', String(runs)],
    ],
  });
  const baseDispose = lab.dispose.bind(lab);
  lab.dispose = () => { baseDispose(); scene.remove(terrain); terrain.geometry.dispose(); };
  return lab;
}

/* ------------------------------------------------------------------ */
/* Bot duel — REAL BotBrain minds on real MoveSim bodies. Each agent   */
/* thinks with the full sense stack (hunt/steer/escape/dodge/fire) and */
/* locomotes through the same physics a player does — nothing staged.  */
/* The shared mind-body rig lives in botAgents.ts.                     */
/* ------------------------------------------------------------------ */

function botDuel(scene: THREE.Scene, loA: BotLoadout, loB: BotLoadout): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: null, time: 0, effects: [] };
  const A = spawnAgent(scene, 'alpha', 0x5ad0ff, -30, loA);
  const B = spawnAgent(scene, 'beta', 0xff6a4d, 30, loB);

  // Shells fly the production visual stack (mesh + glow + ribbons +
  // quarks trail + Explosion); only the flight integrator is lab-side.
  const shells: (ReturnType<typeof spawnShell> & { from: BotAgent; wt: number })[] = [];
  let now = 0, deaths = 0, fires = 0, hits = 0;

  const fire = (f: BotAgent, foe: BotAgent, aim: BotVec) => {
    const s = f.sim.state;
    const d = Math.hypot(aim.x - s.pos.x, aim.y - s.pos.y, aim.z - s.pos.z) || 1;
    const { st, wt } = pickAtRange(f, d);
    if (st.speed <= 0) return; // hitscan pick — no shell to fly in the lab
    const sh = spawnShell({
      weaponType: wt,
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: (aim.x - s.pos.x) / d * st.speed, y: (aim.y - s.pos.y) / d * st.speed, z: (aim.z - s.pos.z) / d * st.speed },
      gravity: st.gravity ? GRAVITY : 0,
      maxAge: 2.5,
      hitTest: (from, pos) => {
        const fp = foe.sim.state.pos;
        return foe.dead <= 0 && segPointDist(from, pos, { x: fp.x, y: fp.y, z: fp.z }) < 1.4;
      },
      onDone: (impact, directHit) => {
        if (!directHit || !impact) return;
        foe.hp -= st.directDamage;
        hits++;
        foe.brain.takeHit(f.sim.state.pos);
        if (foe.hp <= 0) {
          foe.dead = 1.5;
          foe.hp = BOT_HP;
          foe.energy = BOT_ENERGY_MAX;
          foe.mesh.visible = false;
          deaths++;
        }
      },
    }, world) as ReturnType<typeof spawnShell> & { from: BotAgent; wt: number };
    sh.from = f; sh.wt = wt;
    shells.push(sh);
    fires++;
  };

  const thinkOne = (a: BotAgent, foe: BotAgent): void => {
    const s = a.sim.state;
    const out = a.brain.think(1 / 60, {
      pos: s.pos,
      vel: s.vel,
      enemies: foe.dead <= 0
        ? [{ id: foe.name, pos: foe.sim.state.pos, vel: foe.sim.state.vel, alive: true, aimY: -0.7 }]
        : [],
      groundY: (x, z) => hmHeight(FLAT, x, z),
      now,
      energy: a.energy,
      healthFrac: a.hp / BOT_HP,
      // Inbound shells feed the dodge sense — same channel the game host fills.
      threats: shells.filter(b => b.from !== a).map(b => b.sim.pos),
      weaponSpeed: d => pickAtRange(a, d).st.speed,
      weaponGravity: d => pickAtRange(a, d).st.gravity,
    });
    a.lastDest = out.dest;
    a.lastMove = out.move;
    if (out.fire) fire(a, foe, out.fire.aim);
  };

  return {
    tick(dt) {
      now += dt * 1000;
      for (const a of [A, B]) {
        if (a.dead > 0) {
          a.dead -= dt;
          if (a.dead <= 0) respawnAgent(a, a === A ? -30 : 30);
        }
      }
      if (A.dead <= 0) thinkOne(A, B);
      if (B.dead <= 0) thinkOne(B, A);
      for (const a of [A, B]) if (a.dead <= 0) locomoteAgent(a, dt);
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i]!;
        s.tick(dt, world);
        if (s.done) { s.dispose(); shells.splice(i, 1); }
      }
      for (let i = world.effects.length - 1; i >= 0; i--) {
        const fx = world.effects[i]!;
        fx.update(dt);
        if (fx.dead) { fx.dispose(); world.effects.splice(i, 1); }
      }
    },
    sync() {
      for (const a of [A, B]) {
        a.mesh.position.set(a.sim.state.pos.x, a.sim.state.pos.y - 1.5, a.sim.state.pos.z);
        a.mesh.rotation.y = a.yaw;
      }
      for (const s of shells) s.sync();
    },
    dump() {
      return [
        ['alpha hp/en', `${Math.max(0, A.hp)}/${A.energy.toFixed(0)}`],
        ['beta hp/en', `${Math.max(0, B.hp)}/${B.energy.toFixed(0)}`],
        ['alpha spd', botSpeed(A)],
        ['beta spd', botSpeed(B)],
        ['move A', A.lastMove ? JSON.stringify(A.lastMove) : '-'],
        ['move B', B.lastMove ? JSON.stringify(B.lastMove) : '-'],
        ['fires', String(fires)],
        ['hits', String(hits)],
        ['deaths', String(deaths)],
        ['shells live', String(shells.length)],
      ];
    },
    dispose() {
      for (const a of [A, B]) { scene.remove(a.mesh); a.mesh.geometry.dispose(); }
      for (const s of shells) s.dispose();
      for (const fx of world.effects) fx.dispose();
      world.effects.length = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Weapon gym — every projectile weapon firing its real ballistics     */
/* downrange in parallel lanes. Same stats the server loads: speed,    */
/* gravity flag, fuse. Watch mortar lob, disc stay flat, cannon skip.  */
/* ------------------------------------------------------------------ */

// Hitscan / non-projectile types — nothing to arc downrange.
const GYM_EXCLUDE = new Set<number>([
  WeaponType.Melee, WeaponType.Slam, WeaponType.Lightning, WeaponType.Railgun,
  WeaponType.Repair, WeaponType.RemoteRailgun, WeaponType.ClusterBomblet,
  WeaponType.MRVBomblet, WeaponType.Grenade, WeaponType.ClusterBomb,
  WeaponType.ArmorGrenade, WeaponType.Javelin, WeaponType.ImpactGrenade,
  WeaponType.Concussion,
]);

// Low-arc ballistic solve: elevation that lands a shell of speed v on
// the target after g drop — flat-fired gravity lanes fell short of the
// wall before this. Falls back to 45° when v can't reach the range.
function ballisticVel(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, v: number, g: number) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const R = Math.hypot(dx, dz) || 1;
  const h = to.y - from.y;
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * R * R + 2 * h * v2);
  const th = disc > 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * R)) : Math.PI / 4;
  const cos = Math.cos(th), sin = Math.sin(th);
  return { x: dx / R * v * cos, y: v * sin, z: dz / R * v * cos };
}

function weaponGym(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: FLAT, target: null, time: 0, effects: [] };
  const lanes = Object.keys(WeaponType)
    .filter(k => isNaN(Number(k)))
    .map(name => ({ name, wt: WeaponType[name as keyof typeof WeaponType] as number, st: getWeaponStats(WeaponType[name as keyof typeof WeaponType]) }))
    // No projectile config = no visual identity to showcase — beam,
    // hitscan, and belt types all land in GYM_EXCLUDE first anyway.
    .filter(l => !GYM_EXCLUDE.has(l.wt) && l.st.speed > 0 && getProjectileConfig(l.wt))
    // Same gun twice would only prove the table — dedupe by ballistics.
    .filter((l, i, arr) => arr.findIndex(o => o.st.speed === l.st.speed && o.st.gravity === l.st.gravity) === i);

  const W = lanes.length, PITCH = 10;
  const x0 = -((W - 1) * PITCH) / 2;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(W * PITCH + 4, 12, 0.5),
    new THREE.MeshBasicMaterial({ color: 0x22303f }),
  );
  wall.position.set(0, 6, 55);
  scene.add(wall);

  const shells: (ReturnType<typeof spawnShell>)[] = [];
  const padGeo = new THREE.CylinderGeometry(1.5, 1.5, 0.3, 12);
  const laneFx = lanes.map((l, i) => {
    const x = x0 + i * PITCH;
    const pad = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: l.st.gravity ? 0xff9a3a : 0x3aa7ff }));
    pad.position.set(x, 0, -40);
    scene.add(pad);
    return { name: l.name, wt: l.wt, st: l.st, x, pad, fired: 0, done: 0, cd: 0.3 + i * 0.15 };
  });

  const fireLane = (l: (typeof laneFx)[number]) => {
    const from = { x: l.x, y: 2, z: -40 };
    const to = { x: l.x, y: 5, z: 54 };
    const vel = l.st.gravity
      ? ballisticVel(from, to, l.st.speed, GRAVITY)
      : { x: 0, y: 0, z: l.st.speed };
    const s = spawnShell({
      weaponType: l.wt,
      pos: from,
      vel,
      gravity: l.st.gravity ? GRAVITY : 0,
      maxAge: l.st.maxLifetime ?? 30,
      walls: [{ axis: 'z', at: 54 }],
      // Blast scaled to the weapon's real aoe radius — a mortar's boom
      // reads wide next to a disc's pop without any hardcoded sizes.
      blastScale: l.st.aoeRadius > 0 ? l.st.aoeRadius / 6 : 0.6,
      onDone: () => { l.done++; },
    }, world);
    shells.push(s);
    l.fired++;
    l.cd = 1.4;
  };

  return {
    tick(dt) {
      world.time += dt;
      for (const l of laneFx) {
        l.cd -= dt;
        if (l.cd <= 0) fireLane(l);
      }
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i]!;
        s.tick(dt, world);
        if (s.done) { s.dispose(); shells.splice(i, 1); }
      }
      for (let i = world.effects.length - 1; i >= 0; i--) {
        const fx = world.effects[i]!;
        fx.update(dt);
        if (fx.dead) { fx.dispose(); world.effects.splice(i, 1); }
      }
    },
    sync() { for (const s of shells) s.sync(); },
    dump() {
      const rows: [string, string][] = [['lanes', String(laneFx.length)]];
      for (const l of laneFx) rows.push([l.name.toLowerCase(), `${l.fired}/${l.done} v${l.st.speed} g${l.st.gravity ? 1 : 0}`]);
      return rows;
    },
    dispose() {
      for (const s of shells) s.dispose();
      for (const fx of world.effects) fx.dispose();
      world.effects.length = 0;
      for (const l of laneFx) scene.remove(l.pad);
      scene.remove(wall);
      wall.geometry.dispose();
      padGeo.dispose();
    },
  };
}


/* ------------------------------------------------------------------ */

export const SCENARIOS: LabScenario[] = [
  { id: 'weapon-gym', name: 'WEAPON GYM', blurb: 'every weapon firing its real ballistics downrange', create: weaponGym },
  { id: 'bot-duel', name: 'BOT DUEL', blurb: 'real BotBrain minds on MoveSim bodies', create: scene => botDuel(scene, BOT_LOADOUTS[0]!, BOT_LOADOUTS[1]!) },
  { id: 'clash-artillery', name: 'MORTAR vs BRUISER', blurb: 'artillery loadout vs shotgun/cannon bruiser', create: scene => botDuel(scene, BOT_LOADOUTS[7]!, BOT_LOADOUTS[5]!) },
  { id: 'clash-beam', name: 'HOSER vs BEAM RIDER', blurb: 'sprinkler vitality vs lightning/railgun overcharge', create: scene => botDuel(scene, BOT_LOADOUTS[4]!, BOT_LOADOUTS[8]!) },
  { id: 'duel', name: 'DUEL', blurb: 'two fighters trade hitscan-ish bolts', create: duel },
  { id: 'ball-court', name: 'BALL COURT', blurb: 'ballSim bounce + one enraged hunter', create: ballCourt },
  { id: 'mortar-volley', name: 'MORTAR VOLLEY', blurb: 'projStep gravity arcs + terrain impacts', create: mortarVolley },
  { id: 'crawler-pack', name: 'CRAWLER PACK', blurb: 'real creatureSim hunt: wander/chase/windup/pounce', create: crawlerPack },
  { id: 'flyer-ring', name: 'FLYER RING', blurb: 'real creatureFlyer: rakks + gnats orbit/dive/climb a prey point', create: flyerRing },
  { id: 'species-pack', name: 'SPECIES PACK', blurb: 'all ground families hunting one prey: crawler/roller/snake', create: speciesPack },
  { id: 'totem-field', name: 'TOTEM FIELD', blurb: 'real totemSim: charge telegraph → locked beam fire → blink relocate', create: totemField },
  { id: 'baneling-rush', name: 'BANELING RUSH', blurb: 'real banelingSim: fuse-lit rush + pop on the prey point', create: banelingRush },
  { id: 'ski-run', name: 'SKI RUN', blurb: 'real MoveSim skiing a heightfield hill', create: skiRun },
  { id: 'flag-scrim', name: 'FLAG SCRIM', blurb: '4v4 CTF: BotBrain minds on the real role table', create: flagScrim },
];
