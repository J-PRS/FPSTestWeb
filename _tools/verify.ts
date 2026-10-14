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
import { hmSurface, hmHeight } from '../shared/heightfield.ts';
import { InputFlags, JetpackFlags, TargetEventType, type DemoFrame } from '../client/src/demo/types.ts';
import { makeSimBall, stepBall, BALL_BASE_RADIUS, BALL_VARIANT_SCALE, type SimBall } from '../shared/ballSim.ts';
import { lcg32 } from '../shared/simRand.ts';
import { drawBallSpawn, drawSplitVel, drawVariant, SPAWN_SEED_XOR } from '../shared/spawnDice.ts';
import { WEAPONS } from '../shared/weaponTable.ts';
import { GRAVITY } from '../shared/movement.ts';
import { ProjectileEventType } from '../client/src/demo/types.ts';

const file = process.argv[2];
if (!file) { console.error('usage: bun _tools/verify.ts <file.demo> [--eps N]'); process.exit(2); }
const epsArg = process.argv.indexOf('--eps');
const EPS = epsArg > 0 ? Number(process.argv[epsArg + 1]) : 2.5;

const demo = deserializeDemo(new Uint8Array(readFileSync(file)).buffer as ArrayBuffer);
const h = demo.header;
// Score recompute — the events ARE the score. Nothing in the file
// asserts a points claim, so the honest output is what the stream
// proves: shots, ball hits (targetId in the ball lane), spawns served.
{
  const shots = demo.projectileEvents.filter((e): boolean => e.eventType === ProjectileEventType.Fired).length;
  const ballHits = demo.projectileEvents.filter((e): boolean =>
    e.eventType === ProjectileEventType.Hit && e.targetId !== 0 && e.targetType < 64).length;
  const spawns = demo.targetEvents.filter((e): boolean => e.eventType === TargetEventType.Spawned).length;
  const acc = shots > 0 ? (ballHits / shots * 100).toFixed(0) : '0';
  console.log(`  score recompute: ${ballHits} kills / ${shots} shots (${acc}% acc) / ${spawns} spawns served — the events prove this, no claimed score exists in-file`);
}

const noSeed = process.argv.includes('--no-seed');
if (!h.runSeed && !noSeed) {
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

// Frame 0 IS the anchor — clips keep absolute timestamps, so dt must
// start there, not at 0 (a 5.75s bogus integration leg otherwise).
const noTraj = process.argv.includes('--no-traj');
let prevT = demo.frames[0]!.timestamp;
let worst = 0;
let worstFrame: DemoFrame | null = null;
let firstBad: { f: DemoFrame; dx: number; dy: number; dz: number } | null = null;

// Trajectory verify only means something for the recording player —
// remote-sampled clips (bot POV, spectate) carry server truth, not
// replayable input; --no-traj skips it.
for (const f of noTraj ? [] : demo.frames) {
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

// ---- spawn-dice parity -------------------------------------------------
// The runSeed-keyed spawn stream must produce every recorded Spawned
// event in order: ambient = [timer] + [variant?] + ctor draws; split
// child = ctor draws (consumed before pos overwrite) + split-vel draw.
// Split detection: a child records pos = parent's live position, not a
// ring offset — check the parent's last truth before deciding.
const BALL_COLOR_COUNT = 7;
// Variant pool in play? The mode string lies (settings-vs-URL flag) —
// the data doesn't: a variant>0 spawn proves pickVariant drew.
const ambientSpawns = demo.targetEvents.filter((e) => e.targetType < 64 && e.eventType === TargetEventType.Spawned);
const hasVariants = ambientSpawns.some((e) => e.targetType !== 0);
const spawnStream = h.runSeed ? lcg32((h.runSeed ^ SPAWN_SEED_XOR) >>> 0) : null;
spawnStream?.(); // field-init timer draw (nextBallSpawn at field ctor)
let spawnN = 0, spawnBad = 0, ambientIdx = 0;
let spawnWorst = 0, spawnWorstId = -1;

const livePos = new Map<number, { x: number; y: number; z: number }>();

for (const e of spawnStream ? demo.targetEvents : []) {
  if (e.targetType >= 64) {continue;}
  if (e.eventType === TargetEventType.Destroyed) { livePos.delete(e.targetId); continue; }
  if (e.eventType === TargetEventType.Spawned) {
    // Split child: sits at another live ball's last pos — ambient rings
    // sit 100-400m off the player, so a 2m parent match is decisive.
    let isSplit = false;
    for (const p of livePos.values()) {
      if (Math.hypot(p.x - e.posX, p.y - e.posY, p.z - e.posZ) < 2) { isSplit = true; break; }
    }
    const variant = e.targetType as 0 | 1 | 2 | 3;
    if (!isSplit) {
      // Draw contract: boot fill (first 4 ambient) = [variant?]+[ctor];
      // trickle = [timer]+[variant?]+[ctor]. Variant roll only exists in
      // the ambient pool — classic spawns go straight to the ctor.
      if (ambientIdx >= 4) {spawnStream?.();} // trickle timer
      if (hasVariants && spawnStream) {drawVariant(spawnStream);}
      ambientIdx += 1;
    }
    const draw = drawBallSpawn(spawnStream ?? lcg32(0), variant, BALL_COLOR_COUNT);
    let exp: { x: number; y: number; z: number };
    let ev: { x: number; y: number; z: number };
    if (isSplit) {
      const sv = drawSplitVel(spawnStream ?? lcg32(0));
      exp = { x: e.posX, y: e.posY, z: e.posZ }; // pos inherits parent — only vel verifies
      ev = sv;
    } else {
      const p = playerPosAt(e.timestamp);
      const rx = p.x + draw.offX, rz = p.z + draw.offZ;
      exp = { x: rx, y: hmHeight(field, rx, rz) + BALL_BASE_RADIUS * BALL_VARIANT_SCALE[variant] + 5, z: rz };
      ev = draw.vel;
    }
    // The dice decide X/Z + vel — Y is terrain-derived, so the coarse
    // hmap trailer's quantization noise lives there (±~5m). Hard-check
    // the dice outputs; report Y separately.
    const posErr = Math.hypot(exp.x - e.posX, exp.z - e.posZ);
    const velErr = Math.hypot(ev.x - e.velX, ev.y - e.velY, ev.z - e.velZ);
    const err = Math.max(posErr, velErr);
    spawnN += 1;
    if (err > EPS) {spawnBad += 1;}
    if (err > spawnWorst) { spawnWorst = err; spawnWorstId = e.targetId; }
  }
  // Track the last truth per id for split detection — every event re-seeds.
  livePos.set(e.targetId, { x: e.posX, y: e.posY, z: e.posZ });
}

// ---- projectile legs ---------------------------------------------------
// Same re-seed model: each projectile event carries pos+vel, so legs
// verify their own span ballistically (vel.y += GRAVITY*dt — no drag in
// the sim). A forged Hit/Bounce at an unreachable pos lands as a bad
// leg; unrecorded terrain contacts are the knock-class caveat again.
const PROJ_STEP = 0.02;
const projs = new Map<number, { x: number; y: number; z: number; vx: number; vy: number; vz: number; lastT: number; grav: boolean }>();
let projN = 0, projOver = 0, projWorst = 0, projWorstId = -1;

for (const e of demo.projectileEvents) {
  let rec = projs.get(e.projectileId);
  if (!rec || e.eventType === ProjectileEventType.Fired || e.eventType === ProjectileEventType.Bounce) {
    rec = { x: e.posX, y: e.posY, z: e.posZ, vx: e.velX, vy: e.velY, vz: e.velZ, lastT: e.timestamp,
            grav: WEAPONS[e.weaponType]?.gravity === true };
    projs.set(e.projectileId, rec);
    continue;
  }
  // Hit / Destroyed — sim the leg ballistically, compare event pos.
  let rem = e.timestamp - rec.lastT;
  while (rem > 1e-6) {
    const dt = Math.min(PROJ_STEP, rem);
    if (rec.grav) {rec.vy += GRAVITY * dt;}
    rec.x += rec.vx * dt; rec.y += rec.vy * dt; rec.z += rec.vz * dt;
    rec.lastT += dt; rem -= dt;
  }
  const err = Math.hypot(rec.x - e.posX, rec.y - e.posY, rec.z - e.posZ);
  projN += 1;
  if (err > EPS) {projOver += 1;}
  if (err > projWorst) { projWorst = err; projWorstId = e.projectileId; }
  projs.delete(e.projectileId);
}

// Receipt check — a signed matchToken trailer pairs the demo with the
// server's attested outcome. --key <secret> (or KRIBES_SIGN_KEY env)
// verifies the HMAC; absent a key we report presence only.
if (demo.matchToken) {
  const tk = demo.matchToken;
  const key = process.env.KRIBES_SIGN_KEY ?? null;
  if (key) {
    const { verifyToken } = await import('../shared/resultToken.ts');
    const ok = await verifyToken(tk, key);
    console.log(`  matchToken ${ok ? 'SIG-VALID' : 'SIG-INVALID'} match=${tk.matchId} room=${tk.room} mode=${tk.mode} events=${tk.eventHash} sig=${tk.sig.slice(0, 12)}…`);
    if (!ok) { console.log('VERDICT bad-token — the embedded receipt was forged or the key is wrong'); process.exit(1); }
  } else {
    console.log(`  matchToken present (set KRIBES_SIGN_KEY to verify the sig) match=${tk.matchId} events=${tk.eventHash}`);
  }
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
if (spawnN > 0) {
  console.log(`  spawn dice ${spawnN}: ${spawnBad} mismatched, worst ${spawnWorst.toFixed(2)}m ball=${spawnWorstId}`);
}
if (projN > 0) {
  console.log(`  proj legs ${projN}: ${projOver} over eps (${((projOver / projN) * 100).toFixed(0)}%), worst ${projWorst.toFixed(2)}m proj=${projWorstId}`);
  console.log(`  (proj legs verify LOCAL ballistic truth only — networked demos' Hits are server truth and legitimately diverge; server outcomes ride resultToken, not this gate)`);
}
if (spawnBad > 0) {
  console.log(`VERDICT hash-mismatch — spawn dice diverged at ball ${spawnWorstId}; a fabricated Spawned event can't hide in the seeded stream`);
  process.exit(1);
}
if (firstBad) {
  const { f, dx, dy, dz } = firstBad;
  console.log(`VERDICT impossible-trajectory — frame ${f.frameNumber} t=${f.timestamp.toFixed(2)} off=(${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)}) eps=${EPS}`);
  process.exit(1);
}
console.log(`VERDICT valid — trajectory reachable within eps=${EPS}`);
