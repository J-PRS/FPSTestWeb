import type * as THREE from 'three';

// Move-event FX family — jetpack trail, ski dust, footstep dust, plus
// the land/jump transitions that hang off the ground-contact edges.
// Split from Player.ts: owns the per-frame emit pass and its pacing
// accumulators; the host keeps the state they read/write.
export interface EmitHost {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  onGround: boolean;
  prevVelY: number;        // vel.y entering this frame — grounding zeroes it
  wasOnGround: boolean;
  skiing: boolean;         // audio loop flag — written here each frame
  jumpAnimTimer: number;   // tuck-pose re-arm on real lift-off
  skills: { postMove(wasOnGround: boolean, onGround: boolean, prevVelY: number): void };
  model: { landPulse(impactSpeed: number): void } | null;
  onJetpack: ((pos: THREE.Vector3) => void) | null;
  onSki: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null;
  onFootDust: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null;
  onLand: ((impactSpeed: number) => void) | null;
  onJump: ((pos: THREE.Vector3) => void) | null;
  onNetworkJump: ((pos: { x: number; y: number; z: number }) => void) | null;
  onNetworkJetpack: ((pos: { x: number; y: number; z: number }) => void) | null;
}

export class PlayerEmit {
  private stepAcc = 0; // footstep-dust distance accumulator
  private lastJetpackSend = 0;

  constructor(private h: EmitHost) {}

  moveEvents(isJetting: boolean, skiHeld: boolean, jumpHeld: boolean, dt: number): void {
    const {h} = this;
    if (isJetting) {this.jetpack();}
    this.skiDust(skiHeld);
    this.footDust(dt);

    h.skills.postMove(h.wasOnGround, h.onGround, h.prevVelY);

    // Ground-contact sound — any landing transition (slam stacks its own
    // bigger boom on top via onSlam).
    if (!h.wasOnGround && h.onGround) {
      const impact = Math.max(0, -h.prevVelY);
      h.model?.landPulse(impact);
      h.onLand?.(impact);
    }

    // Trigger jump animation on real lift-off — not every bump crest,
    // or micro-airtime at running speed keeps re-arming the tuck pose
    // and the model "slides" while grounded.
    if (h.wasOnGround && !h.onGround) {
      // Same gate as the anim: crests/micro-detach aren't "jumps" — the
      // wire edge is for remotes to play the hop, and an ungated send
      // trips the server's 10/s rate limit on rough terrain at speed.
      const realJump = jumpHeld || h.vel.y > 3;
      if (realJump) {h.jumpAnimTimer = 0.8;}
      if (jumpHeld && h.onJump) {
        h.onJump(h.pos.clone());
      }
      if (realJump) {h.onNetworkJump?.({ x: h.pos.x, y: h.pos.y, z: h.pos.z });}
    }
    h.wasOnGround = h.onGround;
  }

  // Jetpack trail particles — every frame while burning, plus a ~20/s
  // throttled network event so remotes see the same plume.
  private jetpack(): void {
    const {h} = this;
    if (!h.onJetpack) {return;}
    h.onJetpack(h.pos); // read-only use — no clone, runs every frame
    const now = performance.now();
    if (h.onNetworkJetpack && now - this.lastJetpackSend > 50) {
      this.lastJetpackSend = now;
      h.onNetworkJetpack({ x: h.pos.x, y: h.pos.y, z: h.pos.z });
    }
  }

  // Ski dust particles (when space is held, on ground, and moving)
  private skiDust(skiHeld: boolean): void {
    const {h} = this;
    h.skiing = skiHeld && h.onGround && h.vel.lengthSq() > 10;
    if (h.skiing && h.onSki) {
      h.onSki(h.pos, h.vel); // read-only use — no clones, runs every frame
    }
  }

  // Footstep dust — grounded, not skiing, actually moving. Distance-paced
  // (~0.9m ≈ one puff per step) so a jog puffs at footfall cadence and
  // standing still puffs nothing.
  private footDust(dt: number): void {
    const {h} = this;
    const wsp = Math.hypot(h.vel.x, h.vel.z);
    if (h.onGround && !h.skiing && wsp > 1.5) {
      this.stepAcc += wsp * dt;
      if (this.stepAcc >= 0.9) {
        this.stepAcc = 0;
        h.onFootDust?.(h.pos, h.vel);
      }
    } else {
      this.stepAcc = 0;
    }
  }
}
