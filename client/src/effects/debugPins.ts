import * as THREE from 'three';

import { urlParams } from '../core/params.js';
import { glitch } from '../core/fxDiag.js';
import { settings } from '../core/settings.js';
/** On when F1 (urlParams.debug) OR the WPOS settings toggle - the
 *  latter keeps worldpos trails visible without the debug overlay. */
const wposOn = (): boolean => urlParams.debug || settings.get('fps-wpos');

/** Soak/diag counters: conns created, conns hidden (bad), and the worst
 *  hidden gap in meters. Read via window.__wposDiag in e2e probes. */
const wposDiag = { conns: 0, bad: 0, worst: 0 };
(window as unknown as { __wposDiag?: typeof wposDiag }).__wposDiag = wposDiag;

/** F1 debug position pins - independent of the trail system. Each pin
 *  is a small octahedron (wireframe-sphere read at debug scale) that
 *  fades over ~4s, so you can compare where a body actually WAS vs
 *  where its trail skeleton claims it was. */
interface Pin { x: number; y: number; z: number; t: number; ev?: boolean; }

const LIFE_MS = 1000;   // total lifetime
const HOLD_MS = 700;    // fully bright ~0.7s, fades out over the last 0.3s
const R = 0.35; // octahedron radius, meters
const MAX_PINS = 3000;
const pins: Pin[] = [];
/** Distance-accumulator cadence: pins drop per METERS of travel, not
 *  ms - 4m is exactly 4m at any frame rate. forceDrop resets it the
 *  same way the time gate used to. */
const distAcc = new WeakMap<object, number>();
/** Angle trigger: cumulative direction change since the last pin -
 *  bends pin early so a curve gets real samples instead of chords.
 *  ~15° per pin max; straights stay at the distance spacing. */
const ANG_MAX = 0.052; // 3° max turn per pin
const angAcc = new WeakMap<object, number>();
const lastDir = new WeakMap<object, { x: number; y: number; z: number }>();
/** Wall time of the last dropDebugPin call per owner - step is only
 *  "this frame's travel" when calls are per-frame; skipped ticks
 *  (far-cull, playback) would false-flag a legit hop. */
const lastCall = new WeakMap<object, number>();

// Octahedron edges: 3 axis pairs, 12 edges - a "wireframe ball" that
// stays crisp under LineSegments (~2px), unlike a real sphere mesh.
const OX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const EDGES: [number, number][] = [
  [0, 2], [2, 1], [1, 3], [3, 0],
  [0, 4], [4, 2], [2, 5], [5, 0],
  [1, 4], [4, 3], [3, 5], [5, 1],
];

// Buffer: pins 24 verts + conns 2 + live leash 2 per slot, with slack.
const pos = new Float32Array(MAX_PINS * 30 * 3);
const col = new Float32Array(MAX_PINS * 30 * 3);
let mesh: THREE.LineSegments | null = null;

/** Connectors between consecutive pins per body - the ball's actual
 *  path as a polyline through the sparse markers. Fades like the pins. */
interface Conn { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; t: number; bad?: boolean; }
const conns: Conn[] = [];
const lastPin = new WeakMap<object, Pin>();
/** Per-owner ordered conn chains - the quad builder needs continuity
 *  (shared joints, averaged normals), which a flat cross-owner list
 *  can't give. */
const connChains = new WeakMap<object, Conn[]>();
/** Owners with live chains - WeakMap isn't iterable, so membership is
 *  tracked here (pruned in flush). */
const chainOwners = new Set<object>();
/** Rolling gap history per owner - a new pin gap >2x the running mean
 *  is a teleport/blend discontinuity, surfaced via glitch('pin-gap'). */
const gapLog = new WeakMap<object, number[]>();
/** Owner's most recent position this frame - the live end of the
 *  connector to its last pin (the gap between body and record). */
const livePos = new WeakMap<object, { x: number; y: number; z: number }>();
const liveOwners = new Set<object>();
/** This frame's live-leash segments, snapshot before liveOwners clears
 *  so the quad pass can give the leash real width too. */
const leashList: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] = [];

/** Drop a pin at `p` for `owner` every `spacingM` meters of real
 *  travel - call per frame per body; distance accumulation makes the
 *  spacing exact at any frame rate. Bounces call forceDropDebugPin,
 *  which pins immediately and restarts the accumulator. */
/** `expectJump`: caller knows a blend/correction snap is in flight -
 *  the conn still hides (it's a chord visually) but skips the
 *  unexplained-jump alert that fires on a tight-arc correction. */
/** `expectJump` kept for signature compat; breaks are event-driven via
 *  breakDropDebugPin - the owner knows teleports, no guessing needed. */
/** `ev` marks terrain-contact event pins (bounce/lunge/etc) - a conn
 *  needs an event endpoint to be hideable: teleports only happen at
 *  terrain, so air→air segments can never be flagged. */
export function dropDebugPin(owner: object, p: { x: number; y: number; z: number }, spacingM = 4, expectJump = false, ev = false): void {
  if (!wposOn()) {return;}
  let lp = livePos.get(owner);
  if (!lp) {lp = { x: 0, y: 0, z: 0 }; livePos.set(owner, lp);}
  const callAt = performance.now();
  const callGapMs = callAt - (lastCall.get(owner) ?? callAt);
  lastCall.set(owner, callAt);
  const dx = p.x - lp.x, dy = p.y - lp.y, dz = p.z - lp.z;
  lp.x = p.x; lp.y = p.y; lp.z = p.z;
  liveOwners.add(owner);
  const step = Math.hypot(dx, dy, dz);
  const acc = (distAcc.get(owner) ?? 0) + step;
  // Angle since last pin: compare this step's direction with the
  // previous step's and accumulate the turn.
  const ld = lastDir.get(owner);
  let ang = angAcc.get(owner) ?? 0;
  if (step > 1e-4 && ld) {
    const dot = (dx * ld.x + dy * ld.y + dz * ld.z) / (step * Math.hypot(ld.x, ld.y, ld.z));
    ang += Math.acos(Math.min(1, Math.max(-1, dot)));
  }
  if (step > 1e-4) {lastDir.set(owner, { x: dx, y: dy, z: dz });}
  angAcc.set(owner, ang);
  if (acc < spacingM && ang < ANG_MAX) {distAcc.set(owner, acc); return;}
  // Angle trigger ignores overshoot-carry (a bend isn't distance);
  // distance trigger keeps the remainder so spacing stays exact.
  distAcc.set(owner, acc - spacingM);
  angAcc.set(owner, 0);
  const now = performance.now();
  if (pins.length >= MAX_PINS) {pins.shift();}
  const pin = { x: p.x, y: p.y, z: p.z, t: now, ev };
  pins.push(pin);
  const prev = lastPin.get(owner);
  if (prev) {
    if (conns.length >= MAX_PINS) {conns.shift();}
    const conn: Conn = { x1: prev.x, y1: prev.y, z1: prev.z, x2: pin.x, y2: pin.y, z2: pin.z, t: now };
    conns.push(conn);
    let chain = connChains.get(owner);
    if (!chain) {chain = []; connChains.set(owner, chain);}
    chain.push(conn);
    if (chain.length > 64) {chain.shift();}
    chainOwners.add(owner);
    wposDiag.conns += 1;
    const d = Math.hypot(pin.x - prev.x, pin.y - prev.y, pin.z - prev.z);
    // conn.bad = this segment renders NOTHING (no line, no quad) - it's
    // a discontinuity, not a trail.
    // Two ways a conn goes bad:
    //   1. DECLARED: the owner called breakDropDebugPin (teleport event)
    //   2. DETECTED: long AND sideways AND flat-ish - see below
    let bad = breakNext.delete(owner);
    // Absolute discontinuity cap: pins drop ~every 4m of travel, so a
    // >60m gap is NEVER one hop - it's an unbroken teleport the owner
    // forgot to declare (blend re-seat, seek reconstruct, respawn).
    // Without this the strip draws a sky-spanning chord.
    if (!bad && d > 60) {bad = true;}
    let log = gapLog.get(owner);
    if (!log) {log = []; gapLog.set(owner, log);}
    // Air→air conns can never hide: teleports happen at terrain, and
    // terrain-contact pins are the event-marked ones.
    if (!bad && (prev.ev || pin.ev) && log.length >= 4 && d > 1e-4) {
      // (a) length outlier: >30x the mean of the last 10 gaps
      const avg = log.reduce((a, g): number => a + g, 0) / log.length;
      // (b) direction outlier: >12° off the ball's last movement step
      //     (a teleport chord points somewhere the ball wasn't going)
      const pd = lastDir.get(owner);
      const pdLen = pd ? Math.hypot(pd.x, pd.y, pd.z) : 0;
      const dot = pdLen > 1e-6
        ? ((pin.x - prev.x) * pd!.x + (pin.y - prev.y) * pd!.y + (pin.z - prev.z) * pd!.z) / (d * pdLen)
        : 1;
      const ang = Math.acos(Math.min(1, Math.max(-1, dot)));
      // (c) exemption: steeper than 30° off horizontal is a real
      //     vertical hop, never a teleport - always allowed
      const vert = Math.abs(pin.y - prev.y) / d > 0.5;
      if (d > avg * 30 && ang > 0.21 && !vert) {bad = true;}
    }
    log.push(d);
    if (log.length > 10) {log.shift();}
    if (bad) {
      conn.bad = true;
      wposDiag.bad += 1;
      if (d > wposDiag.worst) {wposDiag.worst = Math.round(d);}
    }
  }
  lastPin.set(owner, pin);
}

/** Event pin (bounce/lunge/teleport): drops immediately AND resets the
 *  distance accumulator - the next periodic pin lands a full spacing
 *  later, so the early one doesn't compress the spacing. */
export function forceDropDebugPin(owner: object, p: { x: number; y: number; z: number }): void {
  if (!wposOn()) {return;}
  distAcc.set(owner, 0);
  angAcc.set(owner, 0);
  lastDir.delete(owner);
  dropDebugPin(owner, p, 0, true, true); // terrain-contact event pin
}

/** Teleport/break event pin: same as forceDrop plus a per-owner flag
 *  that marks the conn from the previous pin `bad` at creation - the
 *  strip ends at the old spot and restarts clean. Event-driven, so a
 *  legitimately fast ball can't false-trigger it. */
const breakNext = new WeakSet<object>();
/** Previous conn's unit direction per owner - the angle leg of the
 *  combined hide rule (long AND turned). */
const lastConnDir = new WeakMap<object, { x: number; y: number; z: number }>();
export function breakDropDebugPin(owner: object, p: { x: number; y: number; z: number }): void {
  breakNext.add(owner);
  forceDropDebugPin(owner, p);
}

// Billboarded "real trail" quads over every GOOD connector: a tapered,
// camera-facing quad per segment, additive-orange like RibbonTrail.
// Bad (anomalous) conns stay 1px red lines only - they're breaks, not
// trail. Lives in its own mesh so the debug lines stay untouched.
const quadPos = new Float32Array(MAX_PINS * 6 * 3);
const quadCol = new Float32Array(MAX_PINS * 6 * 3);
let quadMesh: THREE.Mesh | null = null;
const QUAD_W = 1.2; // half-width at the head = ball radius (BALL_BASE_RADIUS)

function ensureQuadMesh(scene: THREE.Scene): void {
  if (quadMesh) {return;}
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(quadPos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(quadCol, 3).setUsage(THREE.DynamicDrawUsage));
  // Non-indexed triangle pairs; no index buffer needed for quads-as-6-verts.
  quadMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  quadMesh.frustumCulled = false;
  scene.add(quadMesh);
}

/** Rebuild the pin mesh - call once per frame (any caller). `camPos`
 *  feeds the connector quads' billboard side vector. */
export function flushDebugPins(scene: THREE.Scene, camPos?: { x: number; y: number; z: number }): void {
  if (!wposOn()) {
    if (mesh) {mesh.visible = false;}
    if (quadMesh) {quadMesh.visible = false;}
    return;
  }
  if (!mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  ensureQuadMesh(scene);
  const now = performance.now();
  let keep = 0;
  for (const p of pins) {
    if (now - p.t < LIFE_MS) {pins[keep] = p; keep += 1;}
  }
  pins.length = keep;
  let ckeep = 0;
  for (const c of conns) {
    if (now - c.t < LIFE_MS) {conns[ckeep] = c; ckeep += 1;}
  }
  conns.length = ckeep;
  let w = 0;
  const put = (x: number, y: number, z: number, b: number, red = false): void => {
    pos[w] = x; pos[w + 1] = y; pos[w + 2] = z;
    col[w] = b; col[w + 1] = red ? 0 : b * 0.4; col[w + 2] = 0; w += 3; // orange (red when flagged)
  };
  // 1px conn spine is a debug skeleton - F1 only. WPOS-alone mode is
  // trail-only: quads carry the visuals, no wire overlay.
  if (urlParams.debug) {
    for (const c of conns) {
      if (c.bad) {continue;} // discontinuity links render nothing - breaks, not trail
      const b = Math.min(1, (LIFE_MS - (now - c.t)) / (LIFE_MS - HOLD_MS));
      put(c.x1, c.y1, c.z1, b * 0.6); put(c.x2, c.y2, c.z2, b * 0.6);
    }
  }
  // Live leash: body → its last pin, brighter than the recorded path.
  leashList.length = 0;
  for (const o of liveOwners) {
    const lp = livePos.get(o), lp2 = lastPin.get(o);
    if (lp && lp2) {
      // Same hide rule as conns: a >8m leash means the body snapped to
      // somewhere far from its last pin - drawing it paints a chord.
      const d = Math.hypot(lp.x - lp2.x, lp.y - lp2.y, lp.z - lp2.z);
      if (d < 8) {
        if (urlParams.debug) {put(lp.x, lp.y, lp.z, 0.9); put(lp2.x, lp2.y, lp2.z, 0.9);}
        leashList.push({ x1: lp.x, y1: lp.y, z1: lp.z, x2: lp2.x, y2: lp2.y, z2: lp2.z });
      }
    }
  }
  liveOwners.clear();
  // Pin gizmos show only under F1 - WPOS alone is trail-only.
  if (urlParams.debug) {
    for (const p of pins) {
      const b = Math.min(1, (LIFE_MS - (now - p.t)) / (LIFE_MS - HOLD_MS));
      for (const [a, b2] of EDGES) {
        put(p.x + OX[a]![0]! * R, p.y + OX[a]![1]! * R, p.z + OX[a]![2]! * R, b);
        put(p.x + OX[b2]![0]! * R, p.y + OX[b2]![1]! * R, p.z + OX[b2]![2]! * R, b);
      }
    }
  }
  mesh.visible = true;
  (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  mesh.geometry.setDrawRange(0, w / 3);

  // Connector quads: ONE continuous strip per owner - joints share
  // vertices, the side vector at each joint averages the two segment
  // directions, and width is per-VERTEX (fades with that pin's age), so
  // the whole path renders as a single smoothly tapering ribbon. Bad
  // conns break the strip - they're breaks, not chords. The live leash
  // (ball -> last pin) extends the same strip to the body.
  let q = 0;
  if (camPos) {
    const qput = (x: number, y: number, z: number, b: number): void => {
      quadPos[q] = x; quadPos[q + 1] = y; quadPos[q + 2] = z;
      quadCol[q] = b; quadCol[q + 1] = b * 0.35; quadCol[q + 2] = b * 0.05; q += 3;
    };
    // Scratch rails for one run: center pos + side + width + brightness.
    const RP: number[] = []; const RS: number[] = []; const RW: number[] = []; const RB: number[] = [];
    const emitRun = (mult: number): void => {
      const n = RW.length;
      if (n < 2 || q + (n - 1) * 18 > quadPos.length) {RP.length = RS.length = RW.length = RB.length = 0; return;}
      for (let i = 0; i < n; i += 1) {
        // Averaged travel dir at this joint.
        let dx = 0, dy = 0, dz = 0;
        if (i > 0) {dx += RP[i * 3]! - RP[(i - 1) * 3]!; dy += RP[i * 3 + 1]! - RP[(i - 1) * 3 + 1]!; dz += RP[i * 3 + 2]! - RP[(i - 1) * 3 + 2]!;}
        if (i < n - 1) {dx += RP[(i + 1) * 3]! - RP[i * 3]!; dy += RP[(i + 1) * 3 + 1]! - RP[i * 3 + 1]!; dz += RP[(i + 1) * 3 + 2]! - RP[i * 3 + 2]!;}
        const vx = camPos.x - RP[i * 3]!, vy = camPos.y - RP[i * 3 + 1]!, vz = camPos.z - RP[i * 3 + 2]!;
        let sx = dy * vz - dz * vy, sy = dz * vx - dx * vz, sz = dx * vy - dy * vx;
        const sl = Math.hypot(sx, sy, sz);
        if (sl < 1e-6) {sx = 0; sy = 1; sz = 0;}
        else {sx /= sl; sy /= sl; sz /= sl;}
        RS[i * 3] = sx; RS[i * 3 + 1] = sy; RS[i * 3 + 2] = sz;
      }
      for (let i = 1; i < n; i += 1) {
        const i0 = (i - 1) * 3, i1 = i * 3;
        // No length cap: conn.bad already breaks runs at real
        // discontinuities; a long legit hop (fast ball, sparse pins)
        // must draw or the trail eats midair segments.
        const w0 = RW[i - 1]! * mult, w1 = RW[i]! * mult;
        const b0 = RB[i - 1]!, b1 = RB[i]!;
        const ax = RP[i0]! - RS[i0]! * w0, ay = RP[i0 + 1]! - RS[i0 + 1]! * w0, az = RP[i0 + 2]! - RS[i0 + 2]! * w0;
        const bx = RP[i0]! + RS[i0]! * w0, by = RP[i0 + 1]! + RS[i0 + 1]! * w0, bz = RP[i0 + 2]! + RS[i0 + 2]! * w0;
        const cx = RP[i1]! + RS[i1]! * w1, cy = RP[i1 + 1]! + RS[i1 + 1]! * w1, cz = RP[i1 + 2]! + RS[i1 + 2]! * w1;
        const ex = RP[i1]! - RS[i1]! * w1, ey = RP[i1 + 1]! - RS[i1 + 1]! * w1, ez = RP[i1 + 2]! - RS[i1 + 2]! * w1;
        qput(ax, ay, az, b0); qput(bx, by, bz, b0); qput(cx, cy, cz, b1);
        qput(ax, ay, az, b0); qput(cx, cy, cz, b1); qput(ex, ey, ez, b1);
      }
      RP.length = RS.length = RW.length = RB.length = 0;
    };
    const pushVert = (x: number, y: number, z: number, t: number): void => {
      const b = Math.min(1, (LIFE_MS - (now - t)) / (LIFE_MS - HOLD_MS));
      // Width falls linearly across the WHOLE lifetime: full ball-radius
      // at the pin's birth, a thread at death - no flat plateau.
      const life = Math.min(1, Math.max(0, (now - t) / LIFE_MS));
      RP.push(x, y, z);
      RS.push(0, 0, 0);
      RW.push(QUAD_W * Math.max(1 - life, 0.04));
      RB.push(b);
    };
    // Two passes: main strip at full width, secondary at 40% on top.
    for (const mult of [1, 0.4]) {for (const o of chainOwners) {
      const chain = connChains.get(o);
      if (!chain) {chainOwners.delete(o); continue;}
      // Chains outlive the global conn ring (64 entries vs 1s life) -
      // drop expired entries or stale verts keep drawing a thin fan.
      let live = 0;
      for (const c of chain) {
        if (now - c.t < LIFE_MS) {chain[live] = c; live += 1;}
      }
      chain.length = live;
      if (live === 0) {chainOwners.delete(o); continue;}
      // Live leash extends the strip to the body itself.
      const lp = livePos.get(o), lp2 = lastPin.get(o);
      if (lp && lp2) {
        const d = Math.hypot(lp.x - lp2.x, lp.y - lp2.y, lp.z - lp2.z);
        if (d > 0.01 && d < 30) {pushVert(lp.x, lp.y, lp.z, now);}
      }
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const c = chain[i]!;
        if (c.bad) {emitRun(mult); continue;}
        // Vertices walk newest->oldest: push the conn's new end (x2) on
        // first good conn, then each conn's old end (x1).
        if (i === chain.length - 1) {pushVert(c.x2, c.y2, c.z2, c.t);}
        pushVert(c.x1, c.y1, c.z1, c.t);
      }
      emitRun(mult);
    }}
  }
  quadMesh!.visible = true;
  (quadMesh!.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (quadMesh!.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  quadMesh!.geometry.setDrawRange(0, q / 3);
}
