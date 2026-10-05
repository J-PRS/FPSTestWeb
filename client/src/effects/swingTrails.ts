// Melee swing slash. There's no arm animation, so the streak IS the
// gesture. Two paths, both ribbons:
//  - local swings re-trace from the live camera EVERY FRAME for their
//    ~0.18s life — the X crossing can't drift off-center or lag at
//    speed, like a viewmodel-attached streak;
//  - remote punches are baked once in world space (someone else's
//    gesture belongs where they threw it).
import * as THREE from 'three';
import { RibbonTrail } from './RibbonTrail.js';

// Drained here — a swipe has no owner entity, so this module-level list
// plays the role DyingRibbons plays for deployable rockets.
const list: RibbonTrail[] = [];

const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dirW = new THREE.Vector3();
// Callers' camera pos/aim — traceStroke owns _side/_up/_dirW/_pos/_vel,
// so the inputs MUST live in dedicated scratches or the trace clobbers
// the direction mid-call (that bug put the X off-screen entirely).
const _camP = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

const SWIPE_SAMPLES = 7;
const SWIPE_REACH = 2.0;
const SWIPE_LEN = 1.9;
const SWIPE_TILT = 0.65;

/** World-space X-slash across `dir` from `origin` — remote players. */
export function swingSwipe(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, color = 0x9fd8ff): void {
  for (const tilt of [SWIPE_TILT, -SWIPE_TILT]) {
    const r = RibbonTrail.acquire(scene, { color, width: 0.45, life: SWIPE_LIFE, billboard: true, tag: 'swipe' });
    _side.crossVectors(dir, _UP);
    if (_side.lengthSq() < 1e-4) {_side.set(1, 0, 0);} else {_side.normalize();}
    _up.crossVectors(_side, dir).normalize();
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    _dirW.copy(_side).multiplyScalar(ct).addScaledVector(_up, st);
    for (let i = 0; i < SWIPE_SAMPLES; i++) {
      const u = i / (SWIPE_SAMPLES - 1);
      const s = (u - 0.5) * SWIPE_LEN;
      _pos.copy(origin).addScaledVector(dir, SWIPE_REACH).addScaledVector(_dirW, s);
      _vel.copy(_dirW).multiplyScalar(10);
      r.push(_pos, _vel, Math.sin(Math.PI * u)); // blade taper
    }
    r.update(0);
    r.stop();
    list.push(r);
  }
}

// ── Camera-pinned X for the local swing ──────────────────────────────
// Ribbons whose samples are re-written from the live camera each frame —
// same hot additive streak look as every other trail, but mathematically
// stuck to the crosshair like a viewmodel element.
const SWIPE_LIFE = 0.18;

function traceStroke(r: RibbonTrail, camPos: THREE.Vector3, camDir: THREE.Vector3, tilt: number, lenScale = 1): void {
  _side.crossVectors(camDir, _UP);
  if (_side.lengthSq() < 1e-4) {_side.set(1, 0, 0);} else {_side.normalize();}
  _up.crossVectors(_side, camDir).normalize();
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  // Stroke direction = side axis rotated ±tilt toward up — the mirrored
  // pair crosses at camPos + camDir·REACH, i.e. dead on the crosshair.
  _dirW.copy(_side).multiplyScalar(ct).addScaledVector(_up, st);
  for (let i = 0; i < SWIPE_SAMPLES; i++) {
    const u = i / (SWIPE_SAMPLES - 1);          // 0..1 along the stroke
    const s = (u - 0.5) * SWIPE_LEN * lenScale;
    _pos.copy(camPos).addScaledVector(camDir, SWIPE_REACH).addScaledVector(_dirW, s);
    _vel.copy(_dirW).multiplyScalar(10);
    // Blade profile — width pinches to a point at both ends (sin curve),
    // fat in the middle. Without it the strip is a constant-width bar.
    r.push(_pos, _vel, Math.sin(Math.PI * u));
  }
}

interface CamSwipe { r: RibbonTrail; cam: THREE.Camera; tilt: number; t: number }
const camSwipes: CamSwipe[] = [];

export function swingSwipeView(scene: THREE.Scene, cam: THREE.Camera, color = 0x9fd8ff): void {
  cam.getWorldPosition(_camP);
  cam.getWorldDirection(_aim);
  for (const tilt of [SWIPE_TILT, -SWIPE_TILT]) {
    const r = RibbonTrail.acquire(scene, { color, width: 0.3, life: SWIPE_LIFE, billboard: true, tag: 'swipe' });
    traceStroke(r, _camP, _aim, tilt);
    r.update(0, cam.position);
    camSwipes.push({ r, cam, tilt, t: SWIPE_LIFE });
  }
}

/** Per-frame drain — cam swipes re-trace from their camera until their
 *  life expires, then join the fading list like every other ribbon. */
export function updateSwings(dt: number, camera?: THREE.Camera): void {
  const camPos = camera?.position;
  for (let i = camSwipes.length - 1; i >= 0; i--) {
    const s = camSwipes[i]!;
    s.t -= dt;
    // Dead swipes DISPOSE, not stop-and-fade — a stopped ribbon freezes
    // in world space and the player flies into the streak's corpse.
    if (s.t <= 0) { s.r.dispose(); camSwipes.splice(i, 1); continue; }
    s.r.clear();
    s.cam.getWorldPosition(_camP);
    s.cam.getWorldDirection(_aim);
    // The swipe sweeps open then collapses: sin envelope on length —
    // full span mid-life, pinches to nothing at expiry.
    traceStroke(s.r, _camP, _aim, s.tilt, Math.sin(Math.PI * (1 - s.t / SWIPE_LIFE)));
    s.r.update(dt, camPos);
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]!;
    r.update(dt, camPos);
    if (r.done) { r.dispose(); list.splice(i, 1); }
  }
}
