import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  GRAVITY,
  WEED_RADIUS, WEED_HEALTH, WEED_SPEED, WEED_HOP,
  WEED_WIND_X, WEED_WIND_Z, WEED_KILL_DIST,
  EMERGE_DUR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

// Procedural tumbleweed, "wound ball" style: real tumbleweeds are a TANGLE
// — stems wrap tangentially around a hollow sphere and interweave, the way
// thread winds onto a ball. The failure mode of radial growth (spikes from
// a core) reads as a sea urchin; tangential confinement is what sells brush.
//
// Recipe: start at a random point inside the shell, then each step takes a
// random turn while STRONGLY damping the radial component of the direction
// — stems are forced to curve around the ball instead of through it.
// Built once at load via TubeGeometry along CatmullRom curves; merged.
const TWIG_R = 0.008;   // stem radius (unit sphere scaled by weed radius)
const BRANCHES = 80;
const STEPS = 9;        // long winding stems
const STEP_LEN = 0.3;
const TANGLE = 0.55;    // how much radial velocity gets eaten per step

function growStem(twigs: THREE.BufferGeometry[], origin: THREE.Vector3, dir: THREE.Vector3, radius: number, steps: number): void {
  const pts: THREE.Vector3[] = [origin.clone()];
  const p = origin.clone();
  const d = dir.clone();

  for (let i = 0; i < steps; i++) {
    // Random turn
    d.add(_rnd.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4));
    const r = Math.max(p.length(), 0.15);
    // Kill radial drift: subtract most of the component along the radial
    // direction so the stem is steered into running ALONG the shell —
    // this is what makes a tangle instead of a starburst
    _radial.copy(p).divideScalar(r);
    d.addScaledVector(_radial, -d.dot(_radial) * TANGLE);
    // Soft shell confinement: above r=0.9 bend inward, below r=0.3 outward —
    // density piles up in the mid-shell where the silhouette lives
    d.addScaledVector(_radial, r > 0.9 ? -0.5 : r < 0.3 ? 0.4 : 0);
    d.normalize();
    p.addScaledVector(d, STEP_LEN);
    pts.push(p.clone());
    if (p.length() > 1.15) {break;} // strayed too far — dead stem

    // Occasional fork — thin child stem diverging tangentially
    if (Math.random() < 0.3 && i > 1) {
      _rnd2.copy(d).add(_radial.multiplyScalar(0.6)).normalize();
      growStem(twigs, p, _rnd2, radius * 0.6, Math.max(2, steps - i - 2));
    }
  }
  if (pts.length < 2) {return;}

  const curve = new THREE.CatmullRomCurve3(pts);
  twigs.push(new THREE.TubeGeometry(curve, steps * 2, radius, 3, false));
}

const _radial = new THREE.Vector3();
const _rnd2 = new THREE.Vector3();
const _rnd = new THREE.Vector3();

// Representative twigs kept aside for death debris — the weed bursts into
// its own real stems, not generic cylinder shards.
let _twigPool: THREE.BufferGeometry[] = [];

export function weedTwigs(): THREE.BufferGeometry[] { return _twigPool; }

function buildTumbleweedGeometry(): THREE.BufferGeometry {
  const twigs: THREE.BufferGeometry[] = [];
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let b = 0; b < BRANCHES; b++) {
    // Seed at a random point in the shell (not the core — tumbleweeds are
    // hollow-ish in the middle, dense at the skin)
    const a = Math.random() * Math.PI * 2;
    const z = Math.random() * 2 - 1;
    const rr = Math.sqrt(1 - z * z);
    const shellR = 0.35 + Math.random() * 0.5;
    origin.set(rr * Math.cos(a) * shellR, z * shellR, rr * Math.sin(a) * shellR);
    // Initial direction: preferentially tangential (perpendicular to radius)
    dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    _radial.copy(origin).normalize();
    dir.addScaledVector(_radial, -dir.dot(_radial)); // strip the radial part
    if (dir.lengthSq() < 0.01) {dir.set(1, 0, 0);}
    dir.normalize();
    growStem(twigs, origin, dir, TWIG_R, STEPS);
  }
  const geo = mergeGeometries(twigs, false)!;
  // Slight squash — real tumbleweeds are oblate, wider than tall
  geo.scale(1, 0.88, 1);
  // Keep ~20 evenly-spread twigs as the debris pool (same squash so shard
  // silhouettes match the live weed — merge copies data, so scale separately)
  _twigPool = twigs.filter((_, i) => i % 4 === 0);
  for (const t of _twigPool) {t.scale(1.0, 0.88, 1.0);}
  geo.computeBoundingSphere();
  return geo;
}

const _geo = buildTumbleweedGeometry();

let _mat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — one twig-ball per weed. */
export function weedParts(): SwarmPart[] {
  if (!_mat) {
    _mat = new THREE.MeshLambertMaterial({ color: 0xFFFFFF });
  }
  return [{ geometry: _geo, material: _mat, castShadow: false }];
}

// Normalized wind direction — matches the ambient dust drift so weeds and
// motes visibly share the same weather.
const WIND_DIR = new THREE.Vector3(WEED_WIND_X, 0, WEED_WIND_Z).normalize();
const KILL_DIST_SQ = WEED_KILL_DIST * WEED_KILL_DIST;

/**
 * Tumbleweed — destructible desert prop. Blows downwind, hops off bumps,
 * pops into debris when shot or blasted. No contact damage; it exists to
 * make the world feel inhabited and to give explosives something extra to
 * send flying.
 */
export class Tumbleweed implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color: THREE.Color;
  scale: number;
  readonly mega: boolean;
  readonly scoreless = true; // a prop, not a kill — no frag payout
  readonly hideHealthBar = true; // props don't get combat UI — even a fat one
  readonly debrisKind = 'brush' as const; // twigs flutter, not rock chunks
  readonly debrisGeos = weedTwigs(); // burst into the weed's own stems
  readonly dieCue = 'rustle' as const; // dry brush crackle, not the alien squeal

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private rollQuat = new THREE.Quaternion();
  private flash = 0;
  private airborne = false;
  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;
  private wobblePhase = Math.random() * Math.PI * 2;

  get disposed(): boolean { return this.dead; }

  constructor(_scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, mega = false) {
    this.id = nextTargetId();
    this.mega = mega;
    // Megaweed: ~2x the ball, tankier, ruddier (an old gnarled root-ball),
    // and worth 3 nuggets — the desert's slot machine
    this.radius = WEED_RADIUS * (mega ? 2 : 1);
    this.health = this.maxHealth = WEED_HEALTH * (mega ? 6 : 1);
    this.scale = mega ? 2.5 : 0.6; // scale drives nugget count on death
    this.color = mega
      ? new THREE.Color(0.42 + Math.random() * 0.1, 0.28 + Math.random() * 0.08, 0.14)
      : new THREE.Color(0.55 + Math.random() * 0.15, 0.42 + Math.random() * 0.1, 0.22); // dry brush
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    // Spawn already rolling — a weed never starts standing still
    const speed = WEED_SPEED * (0.7 + Math.random() * 0.6);
    this.vel = new THREE.Vector3(WIND_DIR.x * speed, 0, WIND_DIR.z * speed);
    this.hasSlots = allocSlots('tumbleweed', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.flash > 0) {this.flash -= dt;}

    const gy = terrain.getHeight(this.pos.x, this.pos.z);

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — no wind physics yet
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = gy + this.radius - this.emergeDepth * (1 - k * k);
    } else if (this.airborne) {
      this.vel.y += GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y - this.radius <= gy) {
        this.pos.y = gy + this.radius;
        this.airborne = false;
        // Tumbleweeds are light — they skip, not thud
        this.vel.y = Math.abs(this.vel.y) > 6 ? WEED_HOP * 0.5 : 0;
        if (this.vel.y > 0) {this.airborne = true;}
        this.vel.x *= 0.9; this.vel.z *= 0.9;
      }
    } else {
      // Wind accelerates toward cruise speed — gusts of jitter on top
      const gust = Math.sin(this.wobblePhase + this.id * 1.7) * 0.5 + 1;
      _dir.copy(WIND_DIR).multiplyScalar(gust);
      this.vel.x += (_dir.x * WEED_SPEED - this.vel.x) * 1.2 * dt;
      this.vel.z += (_dir.z * WEED_SPEED - this.vel.z) * 1.2 * dt;
      this.wobblePhase += dt * 0.8;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      const newGy = terrain.getHeight(this.pos.x, this.pos.z);
      const drop = this.pos.y - this.radius - newGy;

      // Cresting a rise at speed launches the weed; dropping into a dip
      // makes it skid along the floor
      if (drop > 0.35) {
        this.airborne = true;
        this.vel.y = Math.min(WEED_HOP, drop * 4) * (0.5 + Math.random() * 0.5);
      } else {
        this.pos.y = newGy + this.radius;
      }
    }

    // Roll rotation: axis = up × velocity, rate = speed / radius
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }

    // Out of play space — quietly retire (species cap frees the slot)
    if (this.pos.distanceToSquared(playerPos) > KILL_DIST_SQ) {
      this.dead = true;
      return;
    }

    if (this.hasSlots) {
      const swarm = getSwarm('tumbleweed');
      if (swarm) {
        _s.setScalar(this.radius);
        _m.compose(this.pos, this.rollQuat, _s);
        swarm.setMatrix(0, this.swarmSlot, _m);
        const fr = this.flash > 0 ? 4 : 1;
        swarm.setColor(0, this.swarmSlot, this.color.r * fr, this.color.g * fr, this.color.b * fr);
      }
      getShadows()?.set(this, this.pos, this.radius * 1.05, 0.35);
    }
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * (this.mega ? 0.8 : 1.5)); // mega weeds are heavy — blasts shove, not launch
    if (Math.abs(this.vel.y) > 1.5 || force > 10) {this.airborne = true;}
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 1.5);
    if (Math.abs(this.vel.y) > 1.5 || force > 10) {this.airborne = true;}
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('tumbleweed', this);
      this.hasSlots = false;
    }
  }
}
