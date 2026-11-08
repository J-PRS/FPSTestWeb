// Solo-run verification — the server-side gate for challenge-seeded
// submissions. Three tiers, same contract as _tools/verify.ts:
//
//   trajectory   — replay recorded inputs through the same MoveSim the
//                  run ran on over the embedded hmap. First divergence
//                  past eps fails the submission. HARD GATE — a
//                  challenge seed binds the spawn dice, but nothing
//                  stops a forged frame stream except this replay.
//   spawn dice   — replay the runSeed-keyed stream; every recorded
//                  Spawned event must land on its expected draw.
//                  HARD GATE (event-mismatch).
//   ball+proj legs — event-to-event ballistic re-sims. Evidence only:
//                  unrecorded splash knocks legitimately diverge, so
//                  legs report a distribution, never a verdict.
//
// Draw contract (mirrors client entities.ts/balls.ts):
//   field init      : one timer draw
//   boot fill ×4    : [variant?] + ctor draws        (no timer)
//   ambient trickle : [timer] + [variant?] + ctor draws
//   split child     : ctor draws + split-vel draw     (pos inherits parent)
// Variant draws only exist when the pool saw a non-0 variant — the mode
// string lies, the data doesn't.

import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { lcg32 } from '../../shared/simRand.ts';
import { drawBallSpawn, drawSplitVel, drawVariant, SPAWN_SEED_XOR } from '../../shared/spawnDice.ts';
import { makeSimBall, stepBall, type SimBall } from '../../shared/ballSim.ts';
import { hmapToField, hmapFingerprint } from '../../client/src/demo/demoHmap.ts';
import { hmParseBin, hmSurface, type Heightfield } from '../../shared/heightfield.ts';
import { MoveSim, GRAVITY } from '../../shared/movement.ts';
import { WEAPONS } from '../../shared/weaponRows.ts';
import {
  InputFlags, JetpackFlags, TargetEventType, ProjectileEventType,
  type DemoFile, type DemoFrame,
} from '../../client/src/demo/types.ts';

// Map resolution: the trailer's srcHash fingerprints the full-res field
// it was recorded on — scan maps/*.bin once, match it, and the whole
// verification runs at survey precision instead of 96² quantization.
// Unknown hash (deleted/unshipped map) falls back to the trailer.
const mapsDir = join(import.meta.dir, '..', '..', 'maps');
let fieldCache: Map<number, Heightfield | null> | null = null;
function fieldFor(hm: NonNullable<DemoFile['heightmap']>): { field: Heightfield; fullRes: boolean } {
  fieldCache ??= ((): Map<number, Heightfield | null> => {
    const m = new Map<number, Heightfield | null>();
    try {
      for (const f of readdirSync(mapsDir).filter((n): boolean => n.endsWith('.bin'))) {
        const field = hmParseBin(new Uint8Array(readFileSync(join(mapsDir, f))), hm.heightScale, hm.worldScale);
        m.set(hmapFingerprint(field), field);
      }
    } catch { /* maps dir absent — trailer-only */ }
    return m;
  })();
  const real = fieldCache.get(hm.srcHash);
  return real ? { field: real, fullRes: true } : { field: hmapToField(hm), fullRes: false };
}

const BALL_COLOR_COUNT = 7;
const EPS_COARSE = 2.5; // 96² trailer quantization bounds contact eps
const EPS_TIGHT = 0.5;  // full-res map resolved by srcHash — no quantization
const BALL_STEP = 0.05; // client's fixed sim cadence
const PROJ_STEP = 0.02;

export interface SoloVerdict {
  ok: boolean;
  reason?: string;
  // dice gate
  spawnN: number; spawnBad: number; spawnWorst: number; spawnWorstId: number;
  // trajectory gate
  trajWorst: number; trajFrame: number;
  // evidence tiers
  legN: number; legOver: number; legWorst: number;
  projN: number; projOver: number; projWorst: number;
  unbacked: number;
}

export function verifySolo(demo: DemoFile): SoloVerdict {
  const h = demo.header;
  const base = { spawnN: 0, spawnBad: 0, spawnWorst: 0, spawnWorstId: -1,
    trajWorst: 0, trajFrame: -1, legN: 0, legOver: 0, legWorst: 0,
    projN: 0, projOver: 0, projWorst: 0, unbacked: 0 };
  if (!h.runSeed) { return Object.assign({ ok: false, reason: 'unseeded demo (v<7 or unseeded run)' }, base); }
  if (!demo.heightmap) { return Object.assign({ ok: false, reason: 'no hmap trailer' }, base); }
  if (demo.frames.length === 0) { return Object.assign({ ok: false, reason: 'no frames' }, base); }

  const { field, fullRes } = fieldFor(demo.heightmap);
  const EPS = fullRes ? EPS_TIGHT : EPS_COARSE;

  const traj = trajGate(demo, field, EPS);
  if (traj.reason !== undefined) {
    return Object.assign({ ok: false, reason: traj.reason }, base, { trajWorst: traj.worst, trajFrame: traj.frame });
  }

  const dice = diceGate(demo, field, EPS);
  if (dice.spawnBad > 0) {
    return Object.assign({ ok: false, reason: `spawn dice diverged at ball ${dice.spawnWorstId} (${dice.spawnWorst.toFixed(2)}m)` }, base,
      { trajWorst: traj.worst, trajFrame: traj.frame, spawnN: dice.spawnN, spawnBad: dice.spawnBad, spawnWorst: dice.spawnWorst, spawnWorstId: dice.spawnWorstId, legN: dice.legN, legOver: dice.legOver, legWorst: dice.legWorst });
  }

  const proj = projLegs(demo, EPS);
  const unbacked = unbackedKills(demo);

  return Object.assign({ ok: true }, base, { trajWorst: traj.worst, trajFrame: traj.frame, spawnN: dice.spawnN, spawnBad: dice.spawnBad, spawnWorst: dice.spawnWorst, spawnWorstId: dice.spawnWorstId, legN: dice.legN, legOver: dice.legOver, legWorst: dice.legWorst, projN: proj.projN, projOver: proj.projOver, projWorst: proj.projWorst, unbacked });
}

// ---- trajectory gate -------------------------------------------------
// HARD GATE: replay recorded inputs through the same MoveSim the run ran
// on over the embedded hmap. First divergence past eps fails the
// submission - a challenge seed binds the spawn dice, but nothing stops
// a forged frame stream except this replay. Frame 0 IS the anchor -
// clips keep absolute timestamps.
function trajGate(demo: DemoFile, field: Heightfield, EPS: number): { worst: number; frame: number; reason?: string } {
  const h = demo.header;
  const surface = hmSurface(field);
  const sim = new MoveSim(surface, {
    pos: { x: h.startPosX, y: h.startPosY, z: h.startPosZ },
    vel: { x: h.startVelX, y: h.startVelY, z: h.startVelZ },
    yaw: h.startYaw, pitch: h.startPitch, onGround: false,
  });
  let prevT = demo.frames[0]!.timestamp;
  let worst = 0, frame = -1;
  let firstBad: DemoFrame | null = null;

  for (const f of demo.frames) {
    const dt = Math.max(0, f.timestamp - prevT);
    prevT = f.timestamp;
    sim.setInput({
      forward: (f.inputFlags & InputFlags.Forward ? 1 : 0) - (f.inputFlags & InputFlags.Backward ? 1 : 0),
      right: (f.inputFlags & InputFlags.Right ? 1 : 0) - (f.inputFlags & InputFlags.Left ? 1 : 0),
      jumpPressed: Boolean(f.inputFlags & InputFlags.Jump),
      jumpHeld: Boolean(f.inputFlags & InputFlags.Jump),
      skiHeld: Boolean(f.inputFlags & InputFlags.Ski),
      jetHeld: Boolean(f.jetpackFlags & JetpackFlags.Active),
    });
    // Aim is an input, not a sim output - feed recorded angles.
    sim.state.yaw = f.yaw;
    sim.state.pitch = f.pitch;
    sim.update(dt);
    const err = Math.hypot(sim.state.pos.x - f.posX, sim.state.pos.y - f.posY, sim.state.pos.z - f.posZ);
    if (err > worst) { worst = err; frame = f.frameNumber; }
    if (err > EPS && !firstBad) { firstBad = f; }
  }
  const reason = firstBad ? `impossible-trajectory — frame ${firstBad.frameNumber} t=${firstBad.timestamp.toFixed(2)} (${worst.toFixed(2)}m)` : undefined;
  return { worst, frame, reason };
}

// ---- spawn-dice gate + ball legs -------------------------------------
// One event walk serves both tiers: the runSeed-keyed stream must land
// every recorded Spawned event on its expected draw (HARD GATE), and the
// same pass drives evidence-leg ballistic re-sims. Draw contract mirrors
// client entities.ts/balls.ts:
//   field init      : one timer draw
//   boot fill x4    : [variant?] + ctor draws        (no timer)
//   ambient trickle : [timer] + [variant?] + ctor draws
//   split child     : ctor draws + split-vel draw     (pos inherits parent)
// Variant draws only exist when the pool saw a non-0 variant - the mode
// string lies, the data doesn't.
function diceGate(demo: DemoFile, field: Heightfield, EPS: number): { spawnN: number; spawnBad: number; spawnWorst: number; spawnWorstId: number; legN: number; legOver: number; legWorst: number } {
  const h = demo.header;
  const ambientSpawns = demo.targetEvents.filter(e => e.targetType < 64 && e.eventType === TargetEventType.Spawned);
  const hasVariants = ambientSpawns.some(e => e.targetType !== 0);
  // oxlint-disable-next-line prefer-math-trunc - >>> 0 is uint32 wrap, not truncation
  const stream = lcg32((h.runSeed! ^ SPAWN_SEED_XOR) >>> 0);
  stream(); // field-init timer draw

  const playerPosAt = (t: number): { x: number; y: number; z: number } => {
    const fr = demo.frames;
    if (t <= fr[0]!.timestamp) { return { x: fr[0]!.posX, y: fr[0]!.posY, z: fr[0]!.posZ }; }
    for (let i = 1; i < fr.length; i += 1) {
      if (fr[i]!.timestamp >= t) {
        const a = fr[i - 1]!, b2 = fr[i]!;
        const k = (t - a.timestamp) / Math.max(1e-6, b2.timestamp - a.timestamp);
        return { x: a.posX + (b2.posX - a.posX) * k, y: a.posY + (b2.posY - a.posY) * k, z: a.posZ + (b2.posZ - a.posZ) * k };
      }
    }
    const l = fr[fr.length - 1]!;
    return { x: l.posX, y: l.posY, z: l.posZ };
  };

  const livePos = new Map<number, { x: number; y: number; z: number }>();
  let spawnN = 0, spawnBad = 0, spawnWorst = 0, spawnWorstId = -1, ambientIdx = 0;

  // ball legs state (evidence tier shares the same event walk)
  const balls = new Map<number, { b: SimBall; lastT: number }>();
  let legN = 0, legOver = 0, legWorst = 0;

  for (const e of demo.targetEvents) {
    if (e.targetType >= 64) { continue; }
    if (e.eventType === TargetEventType.Destroyed) { livePos.delete(e.targetId); balls.delete(e.targetId); continue; }
    if (e.eventType === TargetEventType.Spawned) {
      const draw = spawnDraw(stream, e, livePos, hasVariants, ambientIdx, playerPosAt);
      ambientIdx += draw.ambient ? 1 : 0;
      const err = Math.max(
        Math.hypot(draw.ex - e.posX, draw.ez - e.posZ),
        Math.hypot(draw.evx - e.velX, draw.evy - e.velY, draw.evz - e.velZ));
      spawnN += 1;
      if (err > EPS) { spawnBad += 1; }
      if (err > spawnWorst) { spawnWorst = err; spawnWorstId = e.targetId; }
      balls.set(e.targetId, {
        b: makeSimBall(e.targetId, e.targetType as 0 | 1 | 2 | 3, 0,
          { x: e.posX, y: e.posY, z: e.posZ }, { x: e.velX, y: e.velY, z: e.velZ }),
        lastT: e.timestamp,
      });
      livePos.set(e.targetId, { x: e.posX, y: e.posY, z: e.posZ });
      continue;
    }
    // evidence leg - step from last recorded truth to this event
    const rec = balls.get(e.targetId);
    if (!rec) { continue; }
    let rem = e.timestamp - rec.lastT;
    while (rem > 1e-6) {
      const dt = Math.min(BALL_STEP, rem);
      stepBall(rec.b, dt, field, playerPosAt(rec.lastT + dt), false);
      rec.lastT += dt; rem -= dt;
    }
    const err = Math.hypot(rec.b.x - e.posX, rec.b.y - e.posY, rec.b.z - e.posZ);
    legN += 1;
    if (err > EPS) { legOver += 1; }
    if (err > legWorst) { legWorst = err; }
    rec.b.x = e.posX; rec.b.y = e.posY; rec.b.z = e.posZ;
    rec.b.vx = e.velX; rec.b.vy = e.velY; rec.b.vz = e.velZ;
    livePos.set(e.targetId, { x: e.posX, y: e.posY, z: e.posZ });
  }
  return { spawnN, spawnBad, spawnWorst, spawnWorstId, legN, legOver, legWorst };
}

// One Spawned event's expected draw: isSplit probe, trickle/variant
// stream order, then the expected pos/vel the event must match.
// Y is terrain-derived (coarse hmap quantization) - X/Z + vel are the
// dice outputs the stream actually decides.
function spawnDraw(stream: () => number, e: DemoFile['targetEvents'][number], livePos: Map<number, { x: number; y: number; z: number }>, hasVariants: boolean, ambientIdx: number, playerPosAt: (t: number) => { x: number; y: number; z: number }): { ambient: boolean; ex: number; ez: number; evx: number; evy: number; evz: number } {
  let isSplit = false;
  for (const p of livePos.values()) {
    if (Math.hypot(p.x - e.posX, p.y - e.posY, p.z - e.posZ) < 2) { isSplit = true; break; }
  }
  const variant = e.targetType as 0 | 1 | 2 | 3;
  if (!isSplit) {
    if (ambientIdx >= 4) { stream(); } // trickle timer
    if (hasVariants) { drawVariant(stream); }
  }
  const draw = drawBallSpawn(stream, variant, BALL_COLOR_COUNT);
  if (isSplit) {
    const sv = drawSplitVel(stream);
    return { ambient: false, ex: e.posX, ez: e.posZ, evx: sv.x, evy: sv.y, evz: sv.z };
  }
  const p = playerPosAt(e.timestamp);
  return { ambient: true, ex: p.x + draw.offX, ez: p.z + draw.offZ, evx: draw.vel.x, evy: draw.vel.y, evz: draw.vel.z };
}

// ---- projectile legs (evidence only) ---------------------------------
// Event-to-event ballistic re-sim: unrecorded splash knocks legitimately
// diverge, so legs report a distribution, never a verdict.
function projLegs(demo: DemoFile, EPS: number): { projN: number; projOver: number; projWorst: number } {
  const projs = new Map<number, { x: number; y: number; z: number; vx: number; vy: number; vz: number; lastT: number; grav: boolean }>();
  let projN = 0, projOver = 0, projWorst = 0;
  for (const e of demo.projectileEvents) {
    let rec = projs.get(e.projectileId);
    if (!rec || e.eventType === ProjectileEventType.Fired || e.eventType === ProjectileEventType.Bounce) {
      rec = { x: e.posX, y: e.posY, z: e.posZ, vx: e.velX, vy: e.velY, vz: e.velZ, lastT: e.timestamp,
              grav: WEAPONS[e.weaponType]?.gravity === true };
      projs.set(e.projectileId, rec);
      continue;
    }
    let rem = e.timestamp - rec.lastT;
    while (rem > 1e-6) {
      const dt = Math.min(PROJ_STEP, rem);
      if (rec.grav) { rec.vy += GRAVITY * dt; }
      rec.x += rec.vx * dt; rec.y += rec.vy * dt; rec.z += rec.vz * dt;
      rem -= dt;
    }
    const err = Math.hypot(rec.x - e.posX, rec.y - e.posY, rec.z - e.posZ);
    projN += 1;
    if (err > EPS) { projOver += 1; }
    if (err > projWorst) { projWorst = err; }
    rec.lastT = e.timestamp;
    rec.x = e.posX; rec.y = e.posY; rec.z = e.posZ;
  }
  return { projN, projOver, projWorst };
}

// Hit<->shot linkage (evidence): ball dmg/kill events without a
// projectile event in the blast window indicate fabricated kills.
function unbackedKills(demo: DemoFile): number {
  let unbacked = 0;
  for (const e of demo.targetEvents) {
    if (e.targetType >= 64) { continue; }
    if (e.eventType !== TargetEventType.Hit && e.eventType !== TargetEventType.Destroyed) { continue; }
    const near = demo.projectileEvents.some(p =>
      Math.abs(p.timestamp - e.timestamp) < 0.25 &&
      Math.hypot(p.posX - e.posX, p.posY - e.posY, p.posZ - e.posZ) < 12);
    if (!near) { unbacked += 1; }
  }
  return unbacked;
}