import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import type { Bird, Kettle } from './birds.js';

// Per-bird flight modes — dive (aggro), depart (scatter on kill), and the
// two soar modes (loner annulus drift, kettle orbit). Plus the shared
// pose helpers every mode ends through. The flock itself (update loop,
// kettle roam, seeding, shoot/die surface) stays in birds.ts.

const ALT_MIN = 45;
const DIVE_SPEED = 55;
const PECK_RANGE = 3;
const PECK_CD = 0.9;
const PULLUP_TIME = 1.4;
const SEP_R2 = 9; // bird-vs-bird separation distance² (3m)

const _target = new THREE.Vector3();
const _next = new THREE.Vector3();
const _rep = new THREE.Vector3();

export interface FlightHost {
  birds: Bird[];
  kettles: Kettle[];
  aggroT: number;
  departT: number;
  onPeck: ((pos: THREE.Vector3) => void) | null;
}

export class BirdFlight {
  constructor(private h: FlightHost) {}
  /** Aggro decay — calm down when the timer runs out or the corpse stops
   *  being interesting (dead players get their sky back immediately). */
  tickAggro(dt: number, playerPos: THREE.Vector3, playerDead: boolean): void {
    if (this.h.aggroT > 0) {
      this.h.aggroT -= dt;
      if (playerDead) {
        // Corpse stops being interesting — but a bird mid-stoop can't just
        // snap back to its thermal. Every bird gets an outward heading and
        // a few seconds of "fly away" before normal soaring resumes.
        this.h.aggroT = 0;
        this.h.departT = 4 + Math.random() * 2;
        for (const b of this.h.birds) {
          if (b.dead) {continue;}
          const bp = b.group.position;
          b.heading = Math.atan2(bp.z - playerPos.z, bp.x - playerPos.x)
            + (Math.random() - 0.5) * 1.2;
          b.peckCd = 0;
          b.pullUp = 0;
        }
      }
    }
    if (this.h.departT > 0) {this.h.departT -= dt;}
  }

  /** Shared wing pose from flapPhase/flapAmp — every flight mode ends here.
   *  Wings flap in the instanced mesh's vertex shader; this just stores the
   *  current dihedral for the per-instance attribute. */
  flapWings(b: Bird): void {
    b.flapPose = Math.sin(b.flapPhase) * (0.15 + b.flapAmp * 0.85) + 0.15;
  }

  /** Vel-derived lookAt + banked turn — dive/depart share the pose. */
  faceFlight(b: Bird, bank: number): void {
    _next.copy(b.group.position).add(b.vel);
    b.group.lookAt(_next);
    b.group.rotateZ(bank);
  }

  /** Kill knockback into position, decay the residue, re-derive vel. */
  knockAndTrack(b: Bird, dt: number, prevX: number, prevY: number, prevZ: number): void {
    const bp = b.group.position;
    bp.addScaledVector(b.kb, dt * 4);
    b.kb.multiplyScalar(Math.exp(-dt * 3));
    b.vel.set((bp.x - prevX) / dt, (bp.y - prevY) / dt, (bp.z - prevZ) / dt);
  }

  // --- DIVEBOMB: aggroed flock ignores all soaring logic ---
  diveBird(b: Bird, dt: number, playerPos: THREE.Vector3): void {
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
      for (const o of this.h.birds) {
        if (o === b || o.dead) {continue;}
        const d2 = bp.distanceToSquared(o.group.position);
        if (d2 < SEP_R2 && d2 > 1e-4) {
          _rep.copy(bp).sub(o.group.position);
          _next.addScaledVector(_rep, 4 / Math.sqrt(d2));
        }
      }
      if (d < PECK_RANGE && b.peckCd <= 0) {
        this.h.onPeck?.(bp);
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
    this.knockAndTrack(b, dt, prevX, prevY, prevZ);
    this.faceFlight(b, -0.35);
    this.flapWings(b);
  }

  // --- DEPART: kill confirmed — scatter on outward headings, climbing ---
  departBird(b: Bird, dt: number): void {
    const bp = b.group.position;
    const prevX = bp.x, prevY = bp.y, prevZ = bp.z;
    b.flapAmp = 1; // hard flapping climb-out
    b.heading += Math.sin(b.bobPhase * 0.6) * 0.4 * dt; // lazy drift, not a beeline
    bp.x += Math.cos(b.heading) * b.speed * 1.4 * dt;
    bp.z += Math.sin(b.heading) * b.speed * 1.4 * dt;
    bp.y += 14 * dt; // regain soaring altitude as they leave
    this.knockAndTrack(b, dt, prevX, prevY, prevZ);
    this.faceFlight(b, -0.35);
    this.flapWings(b);
  }

  /** Membership churn: birds detach from kettles, loners join them. */
  churnMembership(b: Bird, dt: number): void {
    if (b.kettle === -1) {
      // A loner finding itself near a thermal circles down into it
      if (Math.random() < dt * 0.03) {
        let best = -1, bestD = Infinity;
        for (let ki = 0; ki < this.h.kettles.length; ki++) {
          const k = this.h.kettles[ki]!;
          const dx = k.center.x - b.group.position.x;
          const dz = k.center.z - b.group.position.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = ki; }
        }
        b.kettle = best;
        b.orbitA = Math.atan2(b.group.position.z - this.h.kettles[best]!.center.z,
                            b.group.position.x - this.h.kettles[best]!.center.x);
        b.orbitR = 20 + Math.random() * 55;
      }
    } else if (Math.random() < dt * 0.015) {
      // Peels off the thermal — becomes a loner heading out on its own.
      // Heading starts along the orbit tangent so the departure is smooth.
      b.heading = b.orbitA + (b.orbitW > 0 ? Math.PI / 2 : -Math.PI / 2);
      b.kettle = -1;
    }
  }

  // --- loner: free flight in the 180–450m annulus around the player ---
  soarLoner(b: Bird, dt: number, playerPos: THREE.Vector3, terrain: Terrain): void {
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
    const ground = terrain.getHeightVisual(b.group.position.x, b.group.position.z);
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
  }

  /** Kettle bird: circle its thermal, banking into the orbit tangent. */
  orbitKettle(b: Bird, dt: number): void {
    const k = this.h.kettles[b.kettle]!;
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
