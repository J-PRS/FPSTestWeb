import * as THREE from 'three';

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
const DIVE_SPEED = 55;        // m/s homing
const PECK_RANGE = 3.0;
const PECK_CD = 0.9;          // per bird
const PULLUP_TIME = 1.4;      // climb after a pass
const AGGRO_TIME = 45;        // they hold a grudge

interface Kettle {
  center: THREE.Vector3;
  roamAngle: number;   // position on the lazy orbit ring around the player
  roamDist: number;
  roamW: number;       // its own drift speed — kettles don't march in formation
  wanderPhase: number;
  reformTimer: number; // thermals die and reform elsewhere — kettle relocates
}

interface Bird {
  group: THREE.Group;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
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
const _rep = new THREE.Vector3();
const SEP_R2 = 9.0;     // bird-vs-bird separation distance² (3m)

export class AmbientBirds {
  private birds: Bird[] = [];
  /** Push these into entities.targets — birds become shootable. */
  readonly targets: Targetable[] = [];
  /** Called when an aggroed bird connects — wire to player damage. */
  onPeck: ((pos: THREE.Vector3) => void) | null = null;
  private aggroT = 0; // >0: the whole sky hates you
  private departT = 0; // >0: target died mid-frenzy — birds peel off and scatter instead of snapping back to soaring in one frame
  // Fully random bearings/distances — thermals form where they form, not
  // on a designed ring. Occasionally several share a bearing; that's fine.
  private kettles: Kettle[] = Array.from({ length: KETTLE_COUNT }, () => ({
    center: new THREE.Vector3(),
    roamAngle: Math.random() * Math.PI * 2,
    roamDist: 180 + Math.random() * 220,
    roamW: 0.006 + Math.random() * 0.012,
    wanderPhase: Math.random() * Math.PI * 2,
    reformTimer: 40 + Math.random() * 80,
  }));
  private seeded = false;

  /** Live bird world positions — feeds the minimap debug layer. */
  positions(out: THREE.Vector3[]): void {
    out.length = 0;
    for (const b of this.birds) out.push(b.group.position);
  }

  constructor(scene: THREE.Scene) {
    const bodyGeo = new THREE.ConeGeometry(0.12, 0.9, 5);
    bodyGeo.rotateX(-Math.PI / 2); // nose along -Z so lookAt aims it
    // Wing: flat quad hinged at the inner edge (pivot trick — translate the
    // geometry so rotation.z flaps the tip, not the root)
    const wingGeo = new THREE.PlaneGeometry(1.15, 0.38);
    wingGeo.translate(0.575, 0, 0);
    wingGeo.rotateX(-Math.PI / 2); // flat, facing up

    const mat = new THREE.MeshBasicMaterial({ color: 0x1a1410, side: THREE.DoubleSide });

    for (let i = 0; i < BIRD_COUNT; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, mat);
      const wingL = new THREE.Mesh(wingGeo, mat);
      const wingR = new THREE.Mesh(wingGeo, mat);
      wingR.scale.x = -1; // mirror — same geometry, opposite wing
      group.add(body, wingL, wingR);
      // Oversized silhouette — at 150–500m real buzzard scale is invisible
      group.scale.setScalar(3.2);
      scene.add(group);

      this.birds.push({
        group, wingL, wingR,
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
            bb.group.visible = false;
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
  aggro(): void { this.aggroT = AGGRO_TIME; }

  update(dt: number, playerPos: THREE.Vector3, terrain: Terrain, playerDead = false): void {
    // Seed both kettles on their roam rings
    if (!this.seeded) {
      this.seeded = true;
      for (const k of this.kettles) {
        k.center.set(
          playerPos.x + Math.cos(k.roamAngle) * k.roamDist,
          0,
          playerPos.z + Math.sin(k.roamAngle) * k.roamDist,
        );
      }
      // Loners seed somewhere on the horizon ring, free-flying
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

    // Each kettle roams: slow orbit around the player's general area plus a
    // small figure-8 wander — birds drift past the horizon over time and
    // the two groups approach from different bearings.
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

    // Aggro decay — calm down when the timer runs out or the corpse stops
    // being interesting (dead players get their sky back immediately)
    if (this.aggroT > 0) {
      this.aggroT -= dt;
      if (playerDead) {
        // Corpse stops being interesting — but a bird mid-stoop can't just
        // snap back to its thermal. Every bird gets an outward heading and
        // a few seconds of "fly away" before normal soaring resumes.
        this.aggroT = 0;
        this.departT = 4 + Math.random() * 2;
        for (const b of this.birds) {
          if (b.dead) continue;
          const bp = b.group.position;
          b.heading = Math.atan2(bp.z - playerPos.z, bp.x - playerPos.x)
            + (Math.random() - 0.5) * 1.2;
          b.peckCd = 0;
          b.pullUp = 0;
        }
      }
    }
    if (this.departT > 0) this.departT -= dt;

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

      // --- DIVEBOMB: aggroed flock ignores all soaring logic ---
      if (this.aggroT > 0 && !playerDead) {
        const bp = b.group.position;
        const prevX = bp.x, prevY = bp.y, prevZ = bp.z;
        b.peckCd -= dt;
        b.flapAmp = 1; // aggroed birds flap hard constantly — audible anger
        if (b.pullUp > 0) {
          // Climb back out between passes — keeps them off the ground and
          // gives the dive a readable arc instead of a magnet-lock
          b.pullUp -= dt;
          bp.y += 22 * dt;
          bp.x += Math.cos(b.heading) * b.speed * 0.6 * dt;
          bp.z += Math.sin(b.heading) * b.speed * 0.6 * dt;
        } else {
          // Dive STRAIGHT at the player — a tiny per-bird lateral weave
          // keeps each bird on its own line without breaking the "it's
          // coming for ME" read.
          b.orbitA += dt * 2.2;
          _target.copy(playerPos);
          _target.y += Math.sin(b.bobPhase * 1.7) * 1.2;
          _next.copy(_target).sub(bp);
          const d = _next.length();
          // Weave: perpendicular sway, ±1.5m — breaks the single-file
          // convergence while the dive still reads aimed at your face.
          if (d > 0.01) {
            _rep.set(-_next.z, 0, _next.x).normalize();
            _next.addScaledVector(_rep, Math.sin(b.orbitA) * 1.5);
          }
          // Bird-vs-bird separation: gentle radial repulsion so parallel
          // divers never merge into one silhouette.
          for (const o of this.birds) {
            if (o === b || o.dead) continue;
            const d2 = bp.distanceToSquared(o.group.position);
            if (d2 < SEP_R2 && d2 > 1e-4) {
              _rep.copy(bp).sub(o.group.position);
              _next.addScaledVector(_rep, 4 / Math.sqrt(d2));
            }
          }
          if (d < PECK_RANGE && b.peckCd <= 0) {
            this.onPeck?.(bp);
            b.peckCd = PECK_CD;
            b.pullUp = PULLUP_TIME;
            b.heading = Math.random() * Math.PI * 2; // scatter out on a random bearing
          } else if (_next.lengthSq() > 0.01) {
            _next.normalize();
            bp.addScaledVector(_next, DIVE_SPEED * dt);
            b.heading = Math.atan2(_next.z, _next.x);
          }
        }
        // Knockback offset decays — blast-shoved birds slide back on target
        bp.addScaledVector(b.kb, dt * 4);
        b.kb.multiplyScalar(Math.exp(-dt * 3));
        b.vel.set((bp.x - prevX) / dt, (bp.y - prevY) / dt, (bp.z - prevZ) / dt);
        _next.copy(playerPos);
        _next.y = bp.y; // look level-ish — a dive-bombing bird reads tilted via lookAt
        _next.copy(bp).add(b.vel);
        b.group.lookAt(_next);
        b.group.rotateZ(-0.35);
        const flap = Math.sin(b.flapPhase) * (0.15 + b.flapAmp * 0.85) + 0.15;
        b.wingL.rotation.z = flap;
        b.wingR.rotation.z = -flap;
        continue;
      }

      // --- DEPART: kill confirmed — scatter on outward headings, climbing ---
      if (this.departT > 0) {
        const bp = b.group.position;
        const prevX = bp.x, prevY = bp.y, prevZ = bp.z;
        b.flapAmp = 1; // hard flapping climb-out
        b.heading += Math.sin(b.bobPhase * 0.6) * 0.4 * dt; // lazy drift, not a beeline
        bp.x += Math.cos(b.heading) * b.speed * 1.4 * dt;
        bp.z += Math.sin(b.heading) * b.speed * 1.4 * dt;
        bp.y += 14 * dt; // regain soaring altitude as they leave
        bp.addScaledVector(b.kb, dt * 4);
        b.kb.multiplyScalar(Math.exp(-dt * 3));
        b.vel.set((bp.x - prevX) / dt, (bp.y - prevY) / dt, (bp.z - prevZ) / dt);
        _next.copy(bp).add(b.vel);
        b.group.lookAt(_next);
        b.group.rotateZ(-0.35);
        const flap = Math.sin(b.flapPhase) * (0.15 + b.flapAmp * 0.85) + 0.15;
        b.wingL.rotation.z = flap;
        b.wingR.rotation.z = -flap;
        continue;
      }

      // --- membership churn: birds detach from kettles, loners join them ---
      if (b.kettle === -1) {
        // A loner finding itself near a thermal circles down into it
        if (Math.random() < dt * 0.03) {
          let best = -1, bestD = Infinity;
          for (let ki = 0; ki < this.kettles.length; ki++) {
            const k = this.kettles[ki]!;
            const dx = k.center.x - b.group.position.x;
            const dz = k.center.z - b.group.position.z;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = ki; }
          }
          b.kettle = best;
          b.orbitA = Math.atan2(b.group.position.z - this.kettles[best]!.center.z,
                              b.group.position.x - this.kettles[best]!.center.x);
          b.orbitR = 20 + Math.random() * 55;
        }
      } else if (Math.random() < dt * 0.015) {
        // Peels off the thermal — becomes a loner heading out on its own.
        // Heading starts along the orbit tangent so the departure is smooth.
        b.heading = b.orbitA + (b.orbitW > 0 ? Math.PI / 2 : -Math.PI / 2);
        b.kettle = -1;
      }

      const flap = Math.sin(b.flapPhase) * (0.15 + b.flapAmp * 0.85) + 0.15;
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = -flap;

      if (b.kettle === -1) {
        // --- loner: free flight in the 180–450m annulus around the player ---
        const px = b.group.position.x, pz = b.group.position.z;
        const dxP = px - playerPos.x, dzP = pz - playerPos.z;
        const dP = Math.hypot(dxP, dzP);
        // Gentle steering: too far → turn back toward the player; too close → away
        if (dP > 450 || dP < 180) {
          const want = Math.atan2(dzP, dxP) + (dP > 450 ? Math.PI : 0);
          const diff = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
          b.heading += diff * Math.min(1, dt * 0.8);
        }
        b.heading += Math.sin(b.bobPhase * 0.4) * 0.3 * dt; // lazy wander
        const prevX = px, prevZ = pz;
        b.group.position.x += Math.cos(b.heading) * b.speed * dt;
        b.group.position.z += Math.sin(b.heading) * b.speed * dt;
        const ground = terrain.getHeight(b.group.position.x, b.group.position.z);
        const altTarget = ground + ALT_MIN + b.altOff + Math.sin(b.bobPhase * 0.5) * 8;
        b.group.position.y += (altTarget - b.group.position.y) * Math.min(1, dt * 0.5);
        // Face the way it's flying
        _next.set(b.group.position.x + Math.cos(b.heading) * 50,
                  b.group.position.y + (altTarget - b.group.position.y) * 0.5,
                  b.group.position.z + Math.sin(b.heading) * 50);
        b.group.lookAt(_next);
        // Bank into whatever turn the steering is making this frame
        const turn = Math.atan2(b.group.position.x - prevX, b.group.position.z - prevZ) - b.heading;
        b.group.rotateZ(-0.15 - Math.max(-0.4, Math.min(0.4, turn * 2)));
        continue;
      }

      const k = this.kettles[b.kettle]!;
      b.orbitA += b.orbitW * dt;

      // Orbit position — slight vertical bob rides the thermal
      const px = k.center.x + Math.cos(b.orbitA) * b.orbitR;
      const pz = k.center.z + Math.sin(b.orbitA) * b.orbitR;
      const py = k.center.y + b.altOff + Math.sin(b.bobPhase * 0.6) * 1.5
        + Math.sin(b.orbitA * 0.5) * 3; // slow spiral up/down

      // Aim along the orbit tangent, bank into the turn
      _next.set(
        k.center.x + Math.cos(b.orbitA + 0.05) * b.orbitR,
        py,
        k.center.z + Math.sin(b.orbitA + 0.05) * b.orbitR,
      );
      b.group.position.set(px, py, pz);
      b.group.lookAt(_next);
      b.group.rotateZ(-0.25); // bank into the circle
    }
  }
}
