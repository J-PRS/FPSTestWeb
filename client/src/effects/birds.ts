import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BirdFlight } from './birdFlight.js';

import type { Terrain } from '../world/terrain.js';
import type { Targetable } from '../entities/balls.js';
import { nextTargetId } from '../entities/targetIds.js';

// Ambient birds — a small kettle of buzzards riding a thermal above the
// player. Dark silhouettes, banked circling, flap-burst-then-glide wing
// cycles. ~15 draw calls total, zero allocation per frame.
const KETTLE_COUNT = 3;   // separate thermals riding the horizon ring
const BIRD_COUNT = 9;     // 2–4 birds per kettle
const ALT_MIN = 45;
const ALT_MAX = 80;
const DRIFT = 1.6;        // thermal wander speed (m/s)

// ---- Aggro ----
// Shoot a bird and the WHOLE SKY hates you: the flock dive-bombs until
// you're dead or they've had their fill. They're not ambience anymore —
// 200hp each and a peck that removes half a health bar. Don't shoot the
// wildlife.
const BIRD_HEALTH = 200;
const BIRD_RADIUS = 1.2;      // generous — it's a big silhouette
const AGGRO_TIME = 45;        // they hold a grudge

export interface Kettle {
  center: THREE.Vector3;
  roamAngle: number;   // position on the lazy orbit ring around the player
  roamDist: number;
  roamW: number;       // its own drift speed — kettles don't march in formation
  wanderPhase: number;
  reformTimer: number; // thermals die and reform elsewhere — kettle relocates
}

export interface Bird {
  /** Transform holder only — never added to the scene; its matrixWorld is
   *  copied into the shared instanced mesh each frame. */
  group: THREE.Group;
  slot: number;        // instance index in the shared flock mesh
  flapPose: number;    // wing dihedral angle written by flapWings
  kettle: number;      // which thermal this bird rides; -1 = loner
  orbitR: number;      // personal orbit radius (kettle birds)
  orbitA: number;      // current angle
  orbitW: number;      // angular speed
  heading: number;     // loners: free-flight yaw
  speed: number;       // loners: m/s
  altOff: number;      // personal altitude offset
  flapPhase: number;
  flapAmp: number;     // 0 = gliding, 1 = hard flapping
  bobPhase: number;
  // Targetable surface
  id: number;
  dead: boolean;
  health: number;
  vel: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  scale: number;
  scoreless: boolean;
  kb: THREE.Vector3;   // decaying knockback offset (pos is recomputed, so kb is additive)
  // aggro
  peckCd: number;
  pullUp: number;      // >0 = climbing after a peck pass
}

const _target = new THREE.Vector3();
const _next = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

function tagWing(geo: THREE.BufferGeometry, side: number): void {
  const n = geo.getAttribute('position')!.count;
  geo.setAttribute('wingSide', new THREE.BufferAttribute(new Float32Array(n).fill(side), 1));
}

export class AmbientBirds {
  birds: Bird[] = [];  // public — flight family iterates it
  /** Push these into entities.targets — birds become shootable. */
  readonly targets: Targetable[] = [];
  /** Called when an aggroed bird connects — wire to player damage. */
  onPeck: ((pos: THREE.Vector3) => void) | null = null;
  aggroT = 0; // >0: the whole sky hates you
  departT = 0; // >0: target died mid-frenzy — birds peel off and scatter instead of snapping back to soaring in one frame
  // Fully random bearings/distances — thermals form where they form, not
  // on a designed ring. Occasionally several share a bearing; that's fine.
  kettles: Kettle[] = Array.from({ length: KETTLE_COUNT }, () => ({
    center: new THREE.Vector3(),
    roamAngle: Math.random() * Math.PI * 2,
    roamDist: 180 + Math.random() * 220,
    roamW: 0.006 + Math.random() * 0.012,
    wanderPhase: Math.random() * Math.PI * 2,
    reformTimer: 40 + Math.random() * 80,
  }));
  private seeded = false;
  // Dive/depart/soar/orbit flight modes live in birdFlight.ts.
  private flight = new BirdFlight(this);

  /** Live bird world positions — feeds the minimap debug layer. */
  positions(out: THREE.Vector3[]): void {
    out.length = 0;
    for (const b of this.birds) out.push(b.group.position);
  }

  private flock!: THREE.InstancedMesh;
  private flapAttr!: THREE.InstancedBufferAttribute;

  constructor(scene: THREE.Scene) {
    const bodyGeo = new THREE.ConeGeometry(0.12, 0.9, 5);
    bodyGeo.rotateX(-Math.PI / 2); // nose along -Z so lookAt aims it
    tagWing(bodyGeo, 0);
    // Wing: flat quad hinged at the inner edge (pivot trick — translate the
    // geometry so rotation.z flaps the tip, not the root)
    const wingLGeo = new THREE.PlaneGeometry(1.15, 0.38);
    wingLGeo.translate(0.575, 0, 0);
    wingLGeo.rotateX(-Math.PI / 2); // flat, facing up
    tagWing(wingLGeo, 1);
    const wingRGeo = wingLGeo.clone();
    wingRGeo.scale(-1, 1, 1); // mirror — same geometry, opposite wing
    tagWing(wingRGeo, -1);

    // One instanced mesh for the whole kettle — was 3 meshes per bird
    // (27 draws for ambient decor). wingSide tags each vertex so the shader
    // flaps wings about the hinge Z while the body stays rigid.
    const geo = mergeGeometries([bodyGeo, wingLGeo, wingRGeo], false)!;
    const mat = new THREE.MeshBasicMaterial({ color: 0x1a1410, side: THREE.DoubleSide });
    this.flapAttr = new THREE.InstancedBufferAttribute(new Float32Array(BIRD_COUNT), 1);
    this.flapAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFlap', this.flapAttr);
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float wingSide;
          attribute float aFlap;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float wa = aFlap * wingSide;
            float ws = sin(wa), wc = cos(wa);
            transformed.xy = vec2(transformed.x * wc - transformed.y * ws,
                                  transformed.x * ws + transformed.y * wc);
          }`);
    };
    this.flock = new THREE.InstancedMesh(geo, mat, BIRD_COUNT);
    this.flock.matrixWorldAutoUpdate = false;
    this.flock.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flock.frustumCulled = false; // 9 birds span a huge volume — cull math isn't worth it
    scene.add(this.flock);

    for (let i = 0; i < BIRD_COUNT; i++) {
      const group = new THREE.Group();
      // Oversized silhouette — at 150–500m real buzzard scale is invisible
      group.scale.setScalar(3.2);

      this.birds.push({
        group, slot: i, flapPose: 0,
        // Every 4th bird starts a loner — free-fliers roaming the sky
        kettle: (i + 1) % 4 === 0 ? -1 : i % KETTLE_COUNT,
        orbitR: 20 + Math.random() * 55,   // wide spread — a loose kettle, not a dot
        orbitA: Math.random() * Math.PI * 2,
        orbitW: (0.15 + Math.random() * 0.4) * (Math.random() < 0.85 ? 1 : -1), // mostly same-way, a few contrarians
        heading: Math.random() * Math.PI * 2,
        speed: 16 + Math.random() * 10,
        altOff: Math.random() * (ALT_MAX - ALT_MIN) * 0.5,
        flapPhase: Math.random() * Math.PI * 2,
        flapAmp: 0,
        bobPhase: Math.random() * Math.PI * 2,
        id: nextTargetId(),
        dead: false,
        health: BIRD_HEALTH,
        vel: new THREE.Vector3(),
        radius: BIRD_RADIUS,
        color: new THREE.Color(0.25, 0.2, 0.15),
        scale: 0.8,
        scoreless: true, // shooting wildlife shouldn't pay frags/loot
        kb: new THREE.Vector3(),
        peckCd: 0,
        pullUp: 0,
      });

      // Targetable facade — pos/vel are live references into the bird, so
      // projectile sweeps and blasts see the real position every frame.
      const bb = this.birds[this.birds.length - 1]!;
      this.targets.push({
        id: bb.id,
        variant: 0,
        get pos() { return bb.group.position; },
        vel: bb.vel,
        get dead() { return bb.dead; },
        get health() { return bb.health; },
        maxHealth: BIRD_HEALTH,
        radius: BIRD_RADIUS,
        color: bb.color,
        scale: bb.scale,
        scoreless: true,
        lootless: true, // wildlife pays nothing — no frags, no nuggets
        debrisKind: 'brush' as const, // feathers, not rocks
        dieCue: 'squawk' as const, // dying bird screech, not the alien squeal
        takeDamage: (dmg) => {
          bb.health -= dmg;
          this.aggro(); // one shot = the whole flock is coming
          bb.flapAmp = 1;
          if (bb.health <= 0) {
            bb.dead = true;
            return true;
          }
          return false;
        },
        applyKnockback: (from, f) => {
          _next.copy(bb.group.position).sub(from).normalize();
          bb.kb.addScaledVector(_next, f * 0.4);
          bb.flapAmp = 1;
          this.aggro(); // blast wakes them too
        },
        applyPull: (to, f) => {
          _next.copy(to).sub(bb.group.position).normalize();
          bb.kb.addScaledVector(_next, f * 0.4);
          this.aggro();
        },
      });
    }
  }

  /** The whole flock snaps aggro — one bird bleeds, they all dive. */
  aggro(): void { if (this.active) this.aggroT = AGGRO_TIME; }

  /** Dynamic-quality switch — hides the flock and skips the flock sim.
   *  Live birds keep their slots in targets but stay parked. */
  setActive(on: boolean): void {
    this.active = on;
  }
  private active = true;

  update(dt: number, playerPos: THREE.Vector3, terrain: Terrain, playerDead = false): void {
    if (!this.active) {
      for (const b of this.birds) this.flock.setMatrixAt(b.slot, _zero);
      this.flock.instanceMatrix.needsUpdate = true;
      return;
    }
    this.seedFlock(playerPos, terrain);
    this.roamKettles(dt, playerPos, terrain);
    this.flight.tickAggro(dt, playerPos, playerDead);

    for (const b of this.birds) {
      if (b.dead) continue;
      b.flapPhase += dt * (7 + b.flapAmp * 6);
      b.bobPhase += dt;

      // Flap bursts: amp decays to glide, occasionally re-ignites
      if (b.flapAmp > 0) b.flapAmp = Math.max(0, b.flapAmp - dt * 0.5);
      if (Math.random() < dt * 0.25) b.flapAmp = 1; // burst ~every 4s avg
      // Player buzzing a bird scatters it — flap hard
      const pd = b.group.position.distanceToSquared(playerPos);
      if (pd < 225) { b.flapAmp = 1; b.orbitR = Math.min(b.orbitR + dt * 6, 40); }

      if (this.aggroT > 0 && !playerDead) { this.flight.diveBird(b, dt, playerPos); continue; }
      if (this.departT > 0) { this.flight.departBird(b, dt); continue; }
      this.flight.churnMembership(b, dt);
      this.flight.flapWings(b);
      if (b.kettle === -1) this.flight.soarLoner(b, dt, playerPos, terrain);
      else this.flight.orbitKettle(b, dt);
    }
    this.syncFlock();
  }

  /** Push every bird's transform + wing pose into the instanced flock. */
  private syncFlock(): void {
    for (const b of this.birds) {
      if (b.dead) { this.flock.setMatrixAt(b.slot, _zero); continue; }
      b.group.updateMatrix();
      this.flock.setMatrixAt(b.slot, b.group.matrix);
      this.flapAttr.setX(b.slot, b.flapPose);
    }
    this.flock.instanceMatrix.needsUpdate = true;
    this.flapAttr.needsUpdate = true;
  }

  /** Seed both kettles on their roam rings; loners somewhere on the
   *  horizon ring, free-flying. */
  private seedFlock(playerPos: THREE.Vector3, terrain: Terrain): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const k of this.kettles) {
      k.center.set(
        playerPos.x + Math.cos(k.roamAngle) * k.roamDist,
        0,
        playerPos.z + Math.sin(k.roamAngle) * k.roamDist,
      );
    }
    for (const b of this.birds) {
      if (b.kettle === -1) {
        const a = Math.random() * Math.PI * 2, d = 180 + Math.random() * 200;
        b.group.position.set(
          playerPos.x + Math.cos(a) * d,
          terrain.getHeight(playerPos.x + Math.cos(a) * d, playerPos.z + Math.sin(a) * d) + ALT_MIN + b.altOff,
          playerPos.z + Math.sin(a) * d,
        );
        b.heading = Math.random() * Math.PI * 2;
      }
    }
  }

  /** Each kettle roams: slow orbit around the player's general area plus a
   *  small figure-8 wander — birds drift past the horizon over time and
   *  the two groups approach from different bearings. */
  private roamKettles(dt: number, playerPos: THREE.Vector3, terrain: Terrain): void {
    for (let ki = 0; ki < this.kettles.length; ki++) {
      const k = this.kettles[ki]!;
      k.roamAngle += dt * k.roamW;
      k.wanderPhase += dt * 0.07;

      // The thermal collapses: kettle "reforms" at a fresh random bearing
      // and distance. At 200–400m a teleport is invisible — to the player
      // the group simply isn't there anymore and a new one appeared.
      k.reformTimer -= dt;
      if (k.reformTimer <= 0) {
        k.reformTimer = 40 + Math.random() * 80;
        k.roamAngle = Math.random() * Math.PI * 2;
        k.roamDist = 180 + Math.random() * 220;
        k.roamW = 0.006 + Math.random() * 0.012;
        k.center.set(
          playerPos.x + Math.cos(k.roamAngle) * k.roamDist,
          0,
          playerPos.z + Math.sin(k.roamAngle) * k.roamDist,
        );
        // Reseed its birds so the new kettle isn't identically phased
        for (const b of this.birds) {
          if (b.kettle === ki) {
            b.orbitA = Math.random() * Math.PI * 2;
            b.orbitR = 20 + Math.random() * 55;
          }
        }
      }
      _target.set(
        playerPos.x + Math.cos(k.roamAngle) * k.roamDist,
        0,
        playerPos.z + Math.sin(k.roamAngle) * k.roamDist,
      );
      k.center.x += (_target.x - k.center.x) * 0.15 * dt + Math.sin(k.wanderPhase) * DRIFT * dt;
      k.center.z += (_target.z - k.center.z) * 0.15 * dt + Math.cos(k.wanderPhase * 0.7) * DRIFT * dt;
      k.center.y = terrain.getHeight(k.center.x, k.center.z) + ALT_MIN;
    }
  }

}
