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
import type { Heightfield } from '../../../shared/heightfield.js';
import { GRAVITY } from '../../../shared/movement.js';

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

export const SCENARIOS: LabScenario[] = [
  { id: 'duel', name: 'DUEL', blurb: 'two fighters trade hitscan-ish bolts', create: duel },
  { id: 'ball-court', name: 'BALL COURT', blurb: 'ballSim bounce + one enraged hunter', create: ballCourt },
  { id: 'mortar-volley', name: 'MORTAR VOLLEY', blurb: 'projStep gravity arcs + terrain impacts', create: mortarVolley },
];
