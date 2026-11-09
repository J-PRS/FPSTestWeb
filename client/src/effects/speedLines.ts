import * as THREE from 'three';
import { markProbe } from '../core/fxDiag.js';

// World-space speed lines — thin streak quads floating in a disc
// perpendicular to the player's velocity. They're ~stationary in the
// world, so flying through them produces real relative motion: they
// whip past the periphery and converge toward the velocity vanishing
// point, correct for any direction of travel (dive, strafe, bounce).
//
// Camera-attached screen overlays fail at this — they can't converge on
// the true velocity vanishing point and read as static wallpaper.
const MAX_STREAKS = 28;
const MIN_SPEED = 30;    // m/s — no lines below this
const FULL_SPEED = 85;   // full intensity
const DISC_AHEAD_MIN = 3;   // spawn disc sits ahead along -vel
const DISC_AHEAD_MAX = 18;
const DISC_R_MIN = 1.6;  // inner radius — keeps the view center clear
const DISC_R_MAX = 5;
const STREAK_LEN_MIN = 0.9;   // world-space streak length (m)
const STREAK_LEN_MAX = 2;
const LIFE_MIN = 0.35;
const LIFE_MAX = 0.7;

interface Streak {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  drift: THREE.Vector3;
  dead: boolean;
}

const GEO = new THREE.PlaneGeometry(0.025, 1); // unit-length quad, stretched on Y

const _velDir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _upAxis = new THREE.Vector3(0, 1, 0);

export class SpeedLines {
  private scene: THREE.Scene;
  private streaks: Streak[] = [];
  private pool: Streak[] = [];
  private intensity = 0;
  private burstLvl = 0;   // one-shot flare (Bounce) — decays fast
  private spawnAcc = 0;

  /** Momentary flare — e.g. on Bounce redirect. Decays over ~0.4s. */
  burst(): void {
    this.burstLvl = 1;
  }

  /**
   * Tracer-style blink surge — a line of tinted streaks stamped along the
   * travel path so the teleport reads as a whoosh, not a cut. Also flares
   * intensity so they render even if velocity just changed.
   */
  surge(from: THREE.Vector3, to: THREE.Vector3, color = 0x55_CC_FF, count = 14): void {
    _velDir.subVectors(to, from);
    const len = _velDir.length();
    if (len < 0.5) { this.burst(); return; }
    _velDir.normalize();
    _side.crossVectors(_velDir, _upAxis);
    if (_side.lengthSq() < 1e-6) {_side.set(1, 0, 0);} else {_side.normalize();}
    _up.crossVectors(_side, _velDir);

    for (let i = 0; i < count; i += 1) {
      const s = this.alloc();
      const t = Math.random();
      const ang = Math.random() * Math.PI * 2;
      const rad = 0.8 + Math.random() * 2.4;
      _pos.lerpVectors(from, to, t)
        .addScaledVector(_side, Math.cos(ang) * rad)
        .addScaledVector(_up, Math.sin(ang) * rad);
      s.mesh.position.copy(_pos);

      // Same cylindrical billboard orientation as spawnOne — streaks lie
      // along the blink direction
      _toCam.subVectors(_pos, from).addScaledVector(_velDir, -_toCam.dot(_velDir));
      if (_toCam.lengthSq() < 1e-6) {_toCam.set(0, 0, 1);} else {_toCam.normalize();}
      _x.crossVectors(_velDir, _toCam);
      _m.makeBasis(_x, _velDir, _toCam);
      s.mesh.quaternion.setFromRotationMatrix(_m);
      s.mesh.scale.y = STREAK_LEN_MIN + Math.random() * (STREAK_LEN_MAX - STREAK_LEN_MIN);

      s.mat.color.setHex(color);
      s.drift.copy(_velDir).multiplyScalar(-4 - Math.random() * 4);
      s.life = LIFE_MAX;
      s.maxLife = s.life;
      this.streaks.push(s);
    }
    this.burstLvl = 1;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private alloc(): Streak {
    let s = this.pool.pop();
    if (!s) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x9D_B8_D4,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(GEO, mat);
      mesh.frustumCulled = false;
      markProbe(mesh, { kind: 'fxMesh', label: 'speedLine' });
      s = { mesh, mat, life: 0, maxLife: 0, drift: new THREE.Vector3(), dead: true };
    }
    this.scene.add(s.mesh);
    s.dead = false;
    return s;
  }

  private free(s: Streak): void {
    this.scene.remove(s.mesh);
    s.dead = true;
    this.pool.push(s);
  }

  private spawnOne(camPos: THREE.Vector3, velDir: THREE.Vector3): void {
    const s = this.alloc();

    // Random point on a disc ahead of the camera, perpendicular to velocity
    const ahead = DISC_AHEAD_MIN + Math.random() * (DISC_AHEAD_MAX - DISC_AHEAD_MIN);
    const ang = Math.random() * Math.PI * 2;
    const rad = DISC_R_MIN + Math.random() * (DISC_R_MAX - DISC_R_MIN);
    _pos.copy(camPos)
      .addScaledVector(velDir, ahead)
      .addScaledVector(_side, Math.cos(ang) * rad)
      .addScaledVector(_up, Math.sin(ang) * rad);
    s.mesh.position.copy(_pos);

    // Cylindrical billboard: long axis (local Y) along velocity, plane
    // normal (local Z) facing the camera — the quad always reads as a
    // line, never a flat sheet.
    _toCam.subVectors(camPos, _pos).addScaledVector(velDir, -_toCam.dot(velDir)); // reject vel component
    if (_toCam.lengthSq() < 1e-6) {_toCam.set(0, 0, 1);} else {_toCam.normalize();}
    _x.crossVectors(velDir, _toCam); // local X — thin edge
    _m.makeBasis(_x, velDir, _toCam);
    s.mesh.quaternion.setFromRotationMatrix(_m);
    // Length scales with intensity — cruise gets short ticks, top-end
    // speed stretches streaks ~2x longer (the "whip" read, not density).
    const stretch = 1 + this.intensity * 1.2;
    s.mesh.scale.y = (STREAK_LEN_MIN + Math.random() * (STREAK_LEN_MAX - STREAK_LEN_MIN)) * stretch;

    // Backward drift scales with intensity too — at cruise they linger,
    // at speed they streak out of frame, which is the whole effect.
    s.drift.copy(velDir).multiplyScalar(-(2 + this.intensity * 5) - Math.random() * 3);
    s.maxLife = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    s.life = s.maxLife;
    this.streaks.push(s);
  }

  /** Per-frame: camera position + player velocity (world space). */
  update(dt: number, camPos: THREE.Vector3, vel: THREE.Vector3): void {
    const speed = vel.length();
    // Response curve weighted to the top: cruise speeds stay faint
    // (subtle presence), only genuinely fast flight goes dramatic —
    // "ramped but not annoying" = the drama belongs to real speed.
    const linear = Math.min(Math.max((speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED), 0), 1);
    const target = Math.pow(linear, 1.5);
    this.intensity += (target - this.intensity) * Math.min((target > this.intensity ? 10 : 5) * dt, 1);

    // Burst flare — spikes effective intensity past 1 briefly, decays fast
    this.burstLvl *= Math.exp(-dt * 7);
    const effective = Math.min(this.intensity + this.burstLvl * 0.85, 1);

    // Tick live streaks — fade over life, drift slightly against velocity
    for (let i = this.streaks.length - 1; i >= 0; i -= 1) {
      const s = this.streaks[i];
      s.life -= dt;
      if (s.life <= 0 || effective <= 0.01) {
        this.free(s);
        this.streaks.splice(i, 1);
        continue;
      }
      const t = s.life / s.maxLife;
      s.mesh.position.addScaledVector(s.drift, dt);
      // Peak opacity also scales with intensity — dim whisper at
      // cruise, a real rush at cap. Never a solid line.
      s.mat.opacity = effective * t * (0.20 + this.intensity * 0.28);
    }

    if (effective <= 0.01) {return;}

    // Maintain streak population proportional to intensity (burst over-spawns)
    const want = Math.floor(MAX_STREAKS * effective);
    if (speed > 0.01 && this.streaks.length < want) {
      _velDir.copy(vel).normalize();
      // Basis perpendicular to velocity
      _side.crossVectors(_velDir, _upAxis);
      if (_side.lengthSq() < 1e-6) {_side.set(1, 0, 0);} else {_side.normalize();}
      _up.crossVectors(_side, _velDir);

      this.spawnAcc += dt * 60; // up to ~60 spawns/s when ramping up
      while (this.streaks.length < want && this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        this.spawnOne(camPos, _velDir);
      }
    }
  }
}
