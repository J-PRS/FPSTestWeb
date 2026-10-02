/**
 * Sim-lab scenario registry — each entry drives a slice of the shared
 * deterministic sims (shared/ballSim, projSim, movement) inside the lab's
 * own scene. Scenarios own their meshes: create() adds them, dispose()
 * removes them. Nothing here touches the game world, so a buggy or
 * expensive scenario can only ever hurt the lab view.
 */
import * as THREE from 'three';
import { makeSimBall, stepBall, BALL_OVERSPEED, type SimBall, type BallVariant } from '../../../shared/ballSim.js';
import { projStep, segPointDist, segFieldHit, type SimProjectile } from '../../../shared/projSim.js';
import { hmHeight, hmNormal, type Heightfield } from '../../../shared/heightfield.js';
import { GRAVITY, MoveSim, type MoveSurface } from '../../../shared/movement.js';
import { makeSimCrawler, stepCrawler, commitTarget, type SimCrawler } from '../../../shared/creatureCore.js';
import { BotBrain, type BotVec } from '../../../shared/botBrain.js';

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

// Flat field at y=0 — a real Heightfield so the ball sim runs the same
// bounce code the server does, just on a plane instead of the map.
const FLAT: Heightfield = { size: 8, data: new Uint8Array(8 * 8), stride: 1 };

/** Seeded LCG — scenarios pass it as StepWorld.rand so every run replays
 *  identically (teleport rolls included). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const BALL_COLORS = [0x3aa7ff, 0xff7a3a, 0x8aff5a, 0xff4d7e];

/* ------------------------------------------------------------------ */
/* Ball court — free bounce around an arena, one enraged hunter.       */
/* ------------------------------------------------------------------ */

function ballCourt(scene: THREE.Scene): LabInstance {
  const targetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd24d }),
  );
  scene.add(targetMesh);

  const balls: { b: SimBall; m: THREE.Mesh }[] = [];
  const rand = lcg(0x5eed);
  const SEG_COUNTS = new Map<string, number>();
  for (let i = 0; i < 5; i++) {
    const variant = (i % 4) as BallVariant;
    const a = (i / 5) * Math.PI * 2;
    const b = makeSimBall(i, variant, i % BALL_COLORS.length,
      { x: Math.cos(a) * 18, y: 12 + i * 4, z: Math.sin(a) * 18 },
      { x: -Math.sin(a) * 8, y: 0, z: Math.cos(a) * 8 });
    if (i === 0) b.enraged = true; // one hunter tracking the marker
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(b.radius, 16, 16),
      new THREE.MeshBasicMaterial({ color: BALL_COLORS[i % BALL_COLORS.length], wireframe: b.enraged }),
    );
    scene.add(m);
    balls.push({ b, m });
  }

  const target = { x: 0, y: 1.5, z: 0 };
  let t = 0;
  return {
    tick(dt) {
      t += dt;
      target.x = Math.cos(t * 0.4) * 20;
      target.z = Math.sin(t * 0.4) * 20;
      for (const { b } of balls) {
        if (b.dead) continue;
        // Overspeed clamp mirrors ballRage.ts — enrage pulls can stack
        // past it, and without the cap a lab ball leaves the arena.
        const sp = Math.hypot(b.vx, b.vy, b.vz);
        if (sp > BALL_OVERSPEED) {
          const k = BALL_OVERSPEED / sp;
          b.vx *= k; b.vy *= k; b.vz *= k;
        }
        const seg = stepBall(b, dt, FLAT, target, true, { rand });
        if (seg) SEG_COUNTS.set(seg, (SEG_COUNTS.get(seg) ?? 0) + 1);
      }
    },
    sync() {
      for (const { b, m } of balls) m.position.set(b.x, b.y, b.z);
      targetMesh.position.set(target.x, target.y, target.z);
    },
    dump() {
      const e = balls[0]!.b;
      const rows: [string, string][] = [
        ['balls', String(balls.filter(x => !x.b.dead).length)],
        ['enraged', String(balls.filter(x => x.b.enraged).length)],
        ['hunter pos', `${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)}`],
        ['hunter spd', Math.hypot(e.vx, e.vy, e.vz).toFixed(1)],
      ];
      for (const [k, n] of SEG_COUNTS) rows.push([`seg:${k}`, String(n)]);
      return rows;
    },
    dispose() {
      scene.remove(targetMesh);
      targetMesh.geometry.dispose();
      for (const { m } of balls) { scene.remove(m); m.geometry.dispose(); }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Mortar volley — arcing shells between two pads, terrain impacts.    */
/* ------------------------------------------------------------------ */

function mortarVolley(scene: THREE.Scene): LabInstance {
  const padGeo = new THREE.CylinderGeometry(2, 2, 0.4, 16);
  const padA = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: 0x3aa7ff }));
  const padB = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.4, 16), new THREE.MeshBasicMaterial({ color: 0xff7a3a }));
  padA.position.set(-40, 0, 0);
  padB.position.set(40, 0, 0);
  scene.add(padA, padB);

  const shellGeo = new THREE.SphereGeometry(0.5, 10, 10);
  const shellMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });
  const impactMat = new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.7 });
  const shellMat2 = new THREE.MeshBasicMaterial({ color: 0x9adcff });
  const pool: THREE.Mesh[] = [];
  const takeMesh = (mat: THREE.Material) => {
    const m = pool.pop() ?? new THREE.Mesh(shellGeo, shellMat);
    m.material = mat;
    m.visible = true;
    scene.add(m);
    return m;
  };

  interface Shell { p: SimProjectile; m: THREE.Mesh; impact: THREE.Mesh | null; impactT: number }
  const shells: Shell[] = [];
  let side = 0;
  let fired = 0, landed = 0;

  const launch = () => {
    const from = side === 0 ? padA.position : padB.position;
    const to = side === 0 ? padB.position : padA.position;
    side ^= 1;
    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    // 45° lob: range = v²/g → v = sqrt(dist*g); aim flat, let gravity arc.
    const v = Math.sqrt(dist * -GRAVITY);
    const vx = (dx / dist) * v * Math.SQRT1_2;
    const vz = (dz / dist) * v * Math.SQRT1_2;
    const vy = v * Math.SQRT1_2;
    shells.push({
      p: { pos: { x: from.x, y: from.y + 1, z: from.z }, vel: { x: vx, y: vy, z: vz }, age: 0 },
      m: takeShellMesh(), impact: null, impactT: 0,
    });
    fired++;
  };
  const takeShellMesh = () => takeMesh(side === 1 ? shellMat : shellMat2);

  let cd = 0;
  return {
    tick(dt) {
      cd -= dt;
      if (cd <= 0) { launch(); cd = 1.1; }
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i]!;
        if (s.impact) {
          s.impactT += dt;
          const k = 1 + s.impactT * 6;
          s.impact.scale.setScalar(k);
          if (s.impactT > 0.6) {
            scene.remove(s.impact);
            pool.push(s.impact);
            pool.push(s.m);
            s.m.visible = false;
            shells.splice(i, 1);
          }
          continue;
        }
        const from = projStep(s.p, dt, GRAVITY);
        const hit = segFieldHit(from, s.p.pos, FLAT);
        if (hit || s.p.age > 30) {
          landed++;
          s.m.position.set(s.p.pos.x, s.p.pos.y, s.p.pos.z);
          const imp = takeMesh(impactMat);
          imp.position.set(hit?.x ?? s.p.pos.x, (hit?.y ?? 0) + 0.5, hit?.z ?? s.p.pos.z);
          s.impact = imp;
        }
      }
    },
    sync() {
      for (const s of shells) if (!s.impact) s.m.position.set(s.p.pos.x, s.p.pos.y, s.p.pos.z);
    },
    dump() {
      return [
        ['shells in air', String(shells.filter(s => !s.impact).length)],
        ['fired', String(fired)],
        ['landed', String(landed)],
        ['mesh pool', String(pool.length)],
      ];
    },
    dispose() {
      for (const s of shells) { scene.remove(s.m); if (s.impact) scene.remove(s.impact); }
      scene.remove(padA, padB);
      padGeo.dispose();
      shellGeo.dispose();
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
  const SPECIES = ['crawler', 'scarab'] as const;
  const STATE_COLOR: Record<string, number> = { wander: 0x8aa0b5, chase: 0xff9a3a, windup: 0xff3355 };
  const pack: { c: SimCrawler; m: THREE.Mesh; base: number }[] = [];
  const geo = new THREE.ConeGeometry(0.8, 1.6, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const c = makeSimCrawler(i, { x: Math.cos(a) * 25, y: 0, z: Math.sin(a) * 25 }, i === 0, i * 7919 + 3, SPECIES[i % 2]!);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: STATE_COLOR.wander! }));
    scene.add(m);
    pack.push({ c, m, base: c.health });
  }

  const prey = { x: 0, y: 0.5, z: 0 };
  const preyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5ad0ff }),
  );
  scene.add(preyMesh);

  const events = new Map<string, number>();
  let t = 0, retargetAt = 0;
  return {
    tick(dt) {
      t += dt;
      prey.x = Math.cos(t * 0.3) * 18;
      prey.z = Math.sin(t * 0.5) * 18;
      // commitTarget mirrors the wire's retarget event — snapshots, not a
      // live pointer, is what both sims actually steer at.
      if (t >= retargetAt) {
        retargetAt = t + 0.5;
        for (const { c } of pack) commitTarget(c, 'prey', prey);
      }
      for (const { c } of pack) {
        const ev = stepCrawler(c, dt, FLAT, prey, true);
        if (ev) events.set(ev, (events.get(ev) ?? 0) + 1);
      }
    },
    sync() {
      for (const { c, m, base } of pack) {
        m.position.set(c.x, c.y + 0.8, c.z);
        m.rotation.y = -c.yaw;
        (m.material as THREE.MeshBasicMaterial).color.setHex(
          c.dead ? 0x333a44 : STATE_COLOR[c.state] ?? 0x8aa0b5);
        const k = Math.max(0.3, c.health / base);
        m.scale.setScalar(c.uber ? 1.6 : 0.7 + 0.3 * k);
      }
      preyMesh.position.set(prey.x, prey.y, prey.z);
    },
    dump() {
      const rows: [string, string][] = [
        ['pack', String(pack.filter(p => !p.c.dead).length)],
        ['chasing', String(pack.filter(p => p.c.state === 'chase').length)],
        ['winding up', String(pack.filter(p => p.c.state === 'windup').length)],
        ['wandering', String(pack.filter(p => p.c.state === 'wander').length)],
      ];
      for (const [k, n] of events) rows.push([`ev:${k}`, String(n)]);
      return rows;
    },
    dispose() {
      for (const { m } of pack) scene.remove(m);
      scene.remove(preyMesh);
      geo.dispose();
    },
  };
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
  const sim = new MoveSim(surface, {
    pos: { x: HILL_X, y: startY + 2, z: HILL_Z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: false,
  });

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.9, 1.4, 4, 12),
    new THREE.MeshBasicMaterial({ color: 0x6fe3a5 }),
  );
  scene.add(body);

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

  let t = 0, jets = 0, jumps = 0;
  const _n = { x: 0, y: 1, z: 0 };
  return {
    tick(dt) {
      t += dt;
      const s = sim.state;
      // Steer toward the local downhill — same read a skier's eyes do:
      // probe the normal; downhill is -grad ≈ (nx,0,nz) of the surface normal.
      surface.getNormal(s.pos.x, s.pos.z, _n);
      const downX = _n.x, downZ = _n.z;
      const dl = Math.hypot(downX, downZ);
      if (dl > 0.02) sim.state.yaw = Math.atan2(-downX / dl, -downZ / dl);
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
      sim.update(dt);
      // Respawn at the top once the run flattens out — the lab loops forever.
      if (s.pos.y < 3 && speed < 4) {
        sim.setState({
          pos: { x: HILL_X, y: startY + 2, z: HILL_Z },
          vel: { x: 0, y: 0, z: 0 }, yaw: s.yaw, pitch: 0, onGround: false,
        });
        jumps++;
      }
    },
    sync() {
      const s = sim.state;
      body.position.set(s.pos.x, s.pos.y - 1.5, s.pos.z);
    },
    dump() {
      const s = sim.state;
      return [
        ['pos', `${s.pos.x.toFixed(0)}, ${s.pos.y.toFixed(0)}, ${s.pos.z.toFixed(0)}`],
        ['speed', Math.hypot(s.vel.x, s.vel.y, s.vel.z).toFixed(1)],
        ['onGround', String(s.onGround)],
        ['yaw', s.yaw.toFixed(2)],
        ['jet time', `${jets.toFixed(1)}s`],
        ['runs', String(jumps)],
      ];
    },
    dispose() {
      scene.remove(body, terrain);
      body.geometry.dispose();
      terrain.geometry.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bot duel — REAL BotBrain minds on real MoveSim bodies. Each agent   */
/* thinks with the full sense stack (hunt/steer/escape/dodge/fire) and */
/* locomotes through the same physics a player does — nothing staged.  */
/* ------------------------------------------------------------------ */

const BOT_SURFACE: MoveSurface = {
  getHeight: (x, z) => hmHeight(FLAT, x, z),
  getNormal: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
const BOT_HP = 100;
const BOT_ENERGY_MAX = 100;
const BOLT_SPEED = 120;

/** Client's locomote() slew — turn toward dest at a wrist-speed rate. */
function slewYaw(cur: number, want: number, k: number): number {
  let d = want - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const m = Math.abs(d);
  return cur + (m < k ? d : Math.sign(d) * k);
}

interface BotAgent {
  brain: BotBrain;
  sim: MoveSim;
  mesh: THREE.Mesh;
  hp: number;
  energy: number;
  yaw: number;
  lastDest: BotVec | null;
  lastMove: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined;
  name: string;
  dead: number; // respawn countdown
}

interface BotBolt { p: SimProjectile; m: THREE.Mesh; from: BotAgent }

function spawnAgent(scene: THREE.Scene, name: string, color: number, x: number): BotAgent {
  const pos = { x, y: 2, z: 0 };
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.9, 1.4, 4, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  scene.add(mesh);
  return {
    brain: new BotBrain({ ...pos }),
    sim: new MoveSim(BOT_SURFACE, {
      pos: { ...pos }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, onGround: false,
    }),
    mesh, hp: BOT_HP, energy: BOT_ENERGY_MAX, yaw: 0,
    lastDest: null, lastMove: undefined, name, dead: 0,
  };
}

function respawnAgent(a: BotAgent, x: number): void {
  a.sim.setState({
    pos: { x, y: 2, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: a.yaw, pitch: 0, onGround: false,
  });
  a.mesh.visible = true;
}

function locomoteAgent(a: BotAgent, dt: number): void {
  if (!a.lastDest) return;
  const s = a.sim.state;
  const md = Math.hypot(a.lastDest.x - s.pos.x, a.lastDest.z - s.pos.z);
  if (md > 0.01) {
    a.yaw = slewYaw(a.yaw, Math.atan2(a.lastDest.x - s.pos.x, a.lastDest.z - s.pos.z), 5 * dt);
    s.yaw = a.yaw;
  }
  const jet = !!a.lastMove?.jet && a.energy > 0.5;
  a.sim.setInput({
    forward: md > 0.5 ? 1 : 0,
    right: 0,
    jumpHeld: !!a.lastMove?.jump,
    skiHeld: !!a.lastMove?.ski,
    jetHeld: jet,
  });
  a.sim.update(dt);
  // Honest tank: jets burn, regen fills — the brain's skills read this.
  a.energy = Math.min(BOT_ENERGY_MAX, Math.max(0, a.energy + (jet ? -30 : 20) * dt));
}

const botSpeed = (a: BotAgent) => Math.hypot(a.sim.state.vel.x, a.sim.state.vel.y, a.sim.state.vel.z).toFixed(1);

function botDuel(scene: THREE.Scene): LabInstance {
  const A = spawnAgent(scene, 'alpha', 0x5ad0ff, -30);
  const B = spawnAgent(scene, 'beta', 0xff6a4d, 30);

  const boltGeo = new THREE.SphereGeometry(0.25, 8, 8);
  const boltPool: THREE.Mesh[] = [];
  const bolts: BotBolt[] = [];
  let now = 0, deaths = 0, fires = 0, hits = 0;

  const fire = (f: BotAgent, aim: BotVec) => {
    const s = f.sim.state;
    const dx = aim.x - s.pos.x, dy = aim.y - s.pos.y, dz = aim.z - s.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const m = boltPool.pop() ?? new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({ color: 0xfff3a0 }));
    m.visible = true;
    scene.add(m);
    bolts.push({
      p: { pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
           vel: { x: dx / d * BOLT_SPEED, y: dy / d * BOLT_SPEED, z: dz / d * BOLT_SPEED },
           age: 0 },
      m, from: f,
    });
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
      threats: bolts.filter(b => b.from !== a).map(b => b.p.pos),
      weaponSpeed: () => BOLT_SPEED,
      weaponGravity: () => false,
    });
    a.lastDest = out.dest;
    a.lastMove = out.move;
    if (out.fire) fire(a, out.fire.aim);
  };

  /** Bolt flight + hit resolution — segPointDist vs the foe's capsule. */
  const stepBolts = (dt: number): void => {
    for (let i = bolts.length - 1; i >= 0; i--) {
      const bolt = bolts[i]!;
      const from = projStep(bolt.p, dt, 0);
      const foe = bolt.from === A ? B : A;
      const fp = foe.sim.state.pos;
      if (foe.dead <= 0 && segPointDist(from, bolt.p.pos, { x: fp.x, y: fp.y, z: fp.z }) < 1.4) {
        foe.hp -= 20;
        hits++;
        foe.brain.takeHit(bolt.from.sim.state.pos);
        boltPool.push(bolt.m); bolt.m.visible = false;
        bolts.splice(i, 1);
        if (foe.hp <= 0) {
          foe.dead = 1.5;
          foe.hp = BOT_HP;
          foe.energy = BOT_ENERGY_MAX;
          foe.mesh.visible = false;
          deaths++;
        }
        continue;
      }
      if (bolt.p.age > 2.5 || segFieldHit(from, bolt.p.pos, FLAT)) {
        boltPool.push(bolt.m); bolt.m.visible = false;
        bolts.splice(i, 1);
      }
    }
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
      stepBolts(dt);
    },
    sync() {
      for (const a of [A, B]) {
        a.mesh.position.set(a.sim.state.pos.x, a.sim.state.pos.y - 1.5, a.sim.state.pos.z);
        a.mesh.rotation.y = a.yaw;
      }
      for (const bolt of bolts) bolt.m.position.set(bolt.p.pos.x, bolt.p.pos.y, bolt.p.pos.z);
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
        ['bolts live', String(bolts.length)],
      ];
    },
    dispose() {
      for (const a of [A, B]) { scene.remove(a.mesh); a.mesh.geometry.dispose(); }
      for (const bolt of bolts) scene.remove(bolt.m);
      boltGeo.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */

export const SCENARIOS: LabScenario[] = [
  { id: 'bot-duel', name: 'BOT DUEL', blurb: 'real BotBrain minds on MoveSim bodies', create: botDuel },
  { id: 'duel', name: 'DUEL', blurb: 'two fighters trade hitscan-ish bolts', create: duel },
  { id: 'ball-court', name: 'BALL COURT', blurb: 'ballSim bounce + one enraged hunter', create: ballCourt },
  { id: 'mortar-volley', name: 'MORTAR VOLLEY', blurb: 'projStep gravity arcs + terrain impacts', create: mortarVolley },
  { id: 'crawler-pack', name: 'CRAWLER PACK', blurb: 'real creatureSim hunt: wander/chase/windup/pounce', create: crawlerPack },
  { id: 'ski-run', name: 'SKI RUN', blurb: 'real MoveSim skiing a heightfield hill', create: skiRun },
];
