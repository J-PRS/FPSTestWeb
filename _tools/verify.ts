// verify — demo re-simulation verifier, trajectory tier.
// Replays the recorded input stream (inputFlags + yaw/pitch per frame)
// through the same shared MoveSim the run ran on, over the demo's
// embedded heightmap trailer, and asks: could THESE inputs produce
// THAT trajectory?
//
//   bun _tools/verify.ts run.demo [--eps 2.5]
//
// Verdicts:
//   valid                 — every stored frame's pos within --eps of replay
//   impossible-trajectory — first divergence beyond eps (frame + gap)
//   bad-format            — reader threw / no frames / no hmap
//   stale-version         — no runSeed (pre-v7) or unseeded recording
//
// Honest limits, printed on every report: the v5 hmap is a coarse
// downsample (u8 heights, ~gridN cells) — terrain-contact divergence is
// bounded by its quantization, so eps defaults wide (2.5m). Verification
// against the real map file (--map maps/x.bin) tightens it.
import { readFileSync } from 'node:fs';
import { deserializeDemo } from '../client/src/demo/demoReader.ts';
import { hmapToField } from '../client/src/demo/demoHmap.ts';
import { MoveSim } from '../shared/movement.ts';
import { hmSurface } from '../shared/heightfield.ts';
import { InputFlags, JetpackFlags, TargetEventType, type DemoFrame } from '../client/src/demo/types.ts';
import { makeSimBall, stepBall, type SimBall } from '../shared/ballSim.ts';
import { lcg32 } from '../shared/simRand.ts';

const file = process.argv[2];
if (!file) { console.error('usage: bun _tools/verify.ts <file.demo> [--eps N]'); process.exit(2); }
const epsArg = process.argv.indexOf('--eps');
const EPS = epsArg > 0 ? Number(process.argv[epsArg + 1]) : 2.5;

const demo = deserializeDemo(new Uint8Array(readFileSync(file)).buffer as ArrayBuffer);
const h = demo.header;

if (!h.runSeed) {
  console.log(`VERDICT stale-version — runSeed=0 (format v${h.formatVersion}); the dice stream isn't verifiable on this file`);
  process.exit(1);
}
if (demo.frames.length === 0) { console.log('VERDICT bad-format — no frames'); process.exit(1); }
if (!demo.heightmap) { console.log('VERDICT bad-format — no hmap trailer; cannot rebuild the surface'); process.exit(1); }

const field = hmapToField(demo.heightmap);
const surface = hmSurface(field);
const sim = new MoveSim(surface, {
  pos: { x: h.startPosX, y: h.startPosY, z: h.startPosZ },
  vel: { x: h.startVelX, y: h.startVelY, z: h.startVelZ },
  yaw: h.startYaw, pitch: h.startPitch, onGround: false,
});

let prevT = 0;
let worst = 0;
let worstFrame: DemoFrame | null = null;
let firstBad: { f: DemoFrame; dx: number; dy: number; dz: number } | null = null;

for (const f of demo.frames) {
  const dt = Math.max(0, f.timestamp - prevT);
  prevT = f.timestamp;
  // Dead-reckon dedup means a gap holds the LAST input — the recorder
  // only skips frames whose input is identical, so holding the input
  // across the gap is exactly what the live sim did.
  sim.setInput({
    forward: (f.inputFlags & InputFlags.Forward ? 1 : 0) - (f.inputFlags & InputFlags.Backward ? 1 : 0),
    right: (f.inputFlags & InputFlags.Right ? 1 : 0) - (f.inputFlags & InputFlags.Left ? 1 : 0),
    jumpPressed: !!(f.inputFlags & InputFlags.Jump),
    jumpHeld: !!(f.inputFlags & InputFlags.Jump),
    skiHeld: !!(f.inputFlags & InputFlags.Ski),
    jetHeld: !!(f.jetpackFlags & JetpackFlags.Active),
  });
  // Aim is an input, not a sim output — feed the recorded angles, never
  // integrate them.
  sim.state.yaw = f.yaw;
  sim.state.pitch = f.pitch;
  sim.update(dt);

  const dx = sim.state.pos.x - f.posX, dy = sim.state.pos.y - f.posY, dz = sim.state.pos.z - f.posZ;
  const err = Math.hypot(dx, dy, dz);
  if (err > worst) { worst = err; worstFrame = f; }
  if (err > EPS && !firstBad) { firstBad = { f, dx, dy, dz }; }
}

// ---- event tier: ball legs ---------------------------------------------
// Each targetEvent carries full pos+vel — every event re-seeds the leg,
// so a leg verifies its own span: sim forward from the last recorded
// truth to this event's timestamp, compare. Balls hunt the local player
// (target = replayed pos); the live client stepped at fixed 0.05s —
// replicate that cadence exactly. A splash knock between events IS a
// legitimate divergence source (knocks aren't recorded), so legs are
// reported as a distribution, not individually fatal: a forged run
// diverges systematically, honest knock wobble hits a leg or two.
const BALL_STEP = 0.05;
const balls = new Map<number, { b: SimBall; lastT: number }>();
let legN = 0, legOver = 0, legWorst = 0, legWorstId = -1;

// Player pos interp between stored frames — the hunt target the live
// sim saw. Outside the recorded window the endpoints pin.
const playerPosAt = (t: number): { x: number; y: number; z: number } => {
  const fr = demo.frames;
  if (t <= fr[0]!.timestamp) {return { x: fr[0]!.posX, y: fr[0]!.posY, z: fr[0]!.posZ };}
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

for (const e of demo.targetEvents) {
  if (e.targetType >= 64) {continue;} // ball lane only — variants 0-63
  const rec = balls.get(e.targetId);
  if (e.eventType === TargetEventType.Spawned || !rec) {
    balls.set(e.targetId, {
      b: makeSimBall(e.targetId, e.targetType as 0 | 1 | 2 | 3, 0,
        { x: e.posX, y: e.posY, z: e.posZ }, { x: e.velX, y: e.velY, z: e.velZ }),
      lastT: e.timestamp,
    });
    continue;
  }
  // Step the leg in 0.05 quanta — the same cadence the client's replay ran.
  let rem = e.timestamp - rec.lastT;
  while (rem > 1e-6) {
    const dt = Math.min(BALL_STEP, rem);
    stepBall(rec.b, dt, field, playerPosAt(rec.lastT + dt), false);
    rec.lastT += dt; rem -= dt;
  }
  const err = Math.hypot(rec.b.x - e.posX, rec.b.y - e.posY, rec.b.z - e.posZ);
  legN += 1;
  if (err > EPS) {legOver += 1;}
  if (err > legWorst) { legWorst = err; legWorstId = e.targetId; }
  // Re-seed on truth — legs verify independently.
  rec.b.x = e.posX; rec.b.y = e.posY; rec.b.z = e.posZ;
  rec.b.vx = e.velX; rec.b.vy = e.velY; rec.b.vz = e.velZ;
}

console.log(`demo: ${file}`);
console.log(`  mode=${h.mode} room=${h.room} player=${h.playerName} dur=${h.duration.toFixed(1)}s frames=${demo.frames.length} v=${h.formatVersion} seed=0x${h.runSeed.toString(16)}`);
console.log(`  hmap ${demo.heightmap.gridN}² worldScale=${demo.heightmap.worldScale} heightScale=${demo.heightmap.heightScale} — contact eps bounded by downsample quantization`);
if (worstFrame) {
  console.log(`  worst divergence ${worst.toFixed(2)}m at frame ${worstFrame.frameNumber} t=${worstFrame.timestamp.toFixed(2)}`);
}
if (legN > 0) {
  console.log(`  ball legs ${legN}: ${legOver} over eps (${((legOver / legN) * 100).toFixed(0)}%), worst ${legWorst.toFixed(2)}m ball=${legWorstId} — unrecorded knock legs legitimately diverge`);
}
if (firstBad) {
  const { f, dx, dy, dz } = firstBad;
  console.log(`VERDICT impossible-trajectory — frame ${f.frameNumber} t=${f.timestamp.toFixed(2)} off=(${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)}) eps=${EPS}`);
  process.exit(1);
}
console.log(`VERDICT valid — trajectory reachable within eps=${EPS}`);
