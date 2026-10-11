import * as THREE from 'three';

import { FLAG_PICKUP_R } from '../../../../shared/teams.js';
import { GRAVITY } from '../../core/config.js';
import { mkFlagMesh } from '../ctfFlags.js';

const _indAnchor = new THREE.Vector3();

/**
 * Offline rabbit referee — the no-server mirror of the server's RoomFlags
 * + CombatHandler rules. The flag starts unspawned: the FIRST corpse of
 * the match drops it, whoever touches it becomes the rabbit, and while a
 * rabbit exists only damage pairs that include the carrier resolve —
 * rabbit hits everyone, hunters hit the rabbit, hunter-vs-hunter is
 * rejected like friendly fire. Tied-for-last bottom feeders get open
 * season (they can hit and be hit by anyone). Holding ticks +1 pt/sec.
 */
export class RabbitBridge {
  state: 'unspawned' | 'dropped' | 'carried' = 'unspawned';
  carrier: string | null = null;
  /** Loose-flag spot — also the mesh's home while dropped. */
  readonly pos = new THREE.Vector3();
  private holdAcc = 0;
  /** Loose-flag ballistic velocity (RoomFlags.vel parity) — nonzero
   *  means the flag is tumbling, not resting. */
  private flyVel = new THREE.Vector3();
  /** Whose toss is still airborne — the rabbit can't instantly re-grab
   *  its own throw, same guard the server applies. */
  private airborneBy: string | null = null;
  private readonly group = new THREE.Group();

  /** world pos while the flag exists — pos is the loose anchor, group
   *  follows the carrier; the indicator reads whichever is current. */
  flagPos(): THREE.Vector3 { return this.group.position; }

  constructor(
    private d: {
      lazyScene(): THREE.Scene;
      lazyTerrain(): { getHeight(x: number, z: number): number };
      lazyHud(): { updateFlagIndicator(id: string, p: { x: number; y: number; z: number }, cam: THREE.Camera, team: 'rabbit'): void; removePlayerIndicator(id: string): void };
      lazyCamera(): THREE.Camera;
    },
    private announce: (text: string) => void,
  ) {
    // The networked flag's look, no stand — neutral gold since rabbit is FFA.
    this.group.add(mkFlagMesh('alpha', 0xFFCC44));
    this.group.visible = false;
    this.d.lazyScene().add(this.group);
  }

  carrierId(): string | null {
    return this.state === 'carried' ? this.carrier : null;
  }

  /** Damage gate mirroring CombatHandler.friendly — true = blocked.
   *  No carrier (unspawned or loose flag) means open season. */
  blocks(attacker: string, victim: string, bottom: ReadonlySet<string>): boolean {
    if (attacker === victim) {return false;} // self-splash / rocket jumps stay legal
    const c = this.carrierId();
    if (!c || attacker === c || victim === c) {return false;}
    return !(bottom.has(attacker) || bottom.has(victim));
  }

  /** Every corpse is a flag event: the first one spawns it, a rabbit's
   *  drops it loose. Hunters dying leave the flag where it is. */
  onDeath(id: string, pos: THREE.Vector3): void {
    if (this.state === 'unspawned') {
      this.drop(pos);
      this.announce('FLAG LOOSE — GRAB IT');
      return;
    }
    if (this.carrier === id) {this.drop(pos);}
  }

  private drop(pos: THREE.Vector3): void {
    this.state = 'dropped';
    this.carrier = null;
    const dropG = this.d.lazyTerrain().getHeight(pos.x, pos.z);
    this.pos.set(pos.x, Number.isFinite(dropG) ? dropG : pos.y, pos.z);
    this.flyVel.set(0, 3, 0); // same tumble pop RoomFlags.loose gives
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /** Local G-press flag toss — the same claim RoomFlags.throwFor
   *  resolves online: FULL carrier speed inherited, deliberate lob
   *  along aim, airborneBy re-grab guard. */
  throwLocal(carrierId: string, pos: THREE.Vector3, vel: THREE.Vector3,
    yaw: number, pitch: number): void {
    if (this.carrier !== carrierId) {return;}
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this.state = 'dropped';
    this.carrier = null;
    this.pos.copy(pos);
    this.flyVel.set(
      vel.x + cp * Math.sin(yaw) * 20,
      vel.y + 3 + sp * 20,
      vel.z + cp * Math.cos(yaw) * 20);
    this.airborneBy = carrierId;
    this.group.position.copy(this.pos);
    this.group.visible = true;
    this.announce('FLAG THROWN');
  }

  /** Frame tick: touch → rabbit, carry follow, +1/sec hold scoring. */
  update(
    dt: number,
    candidates: { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[],
    posOf: (id: string) => THREE.Vector3 | null,
    scoreHold: (id: string) => void,
  ): void {
    if (this.state === 'unspawned') {return;}
    if (this.state === 'carried') {
      const cp = posOf(this.carrier!);
      if (cp) {
        this.group.position.copy(cp);
        this.group.position.y += 1.2;
      }
      this.holdAcc += dt;
      if (this.holdAcc >= 1) {
        this.holdAcc -= 1;
        scoreHold(this.carrier!);
      }
      return;
    }
    // Dropped: the flag tumbles loose (RoomFlags.tickBallistic parity —
    // world gravity, 0.3 bounce, 4/s skid bleed, settles below 0.6 m/s).
    if (this.flyVel.x || this.flyVel.y || this.flyVel.z) {
      this.flyVel.y += GRAVITY * dt;
      this.pos.addScaledVector(this.flyVel, dt);
      const gy = this.d.lazyTerrain().getHeight(this.pos.x, this.pos.z);
      if (Number.isFinite(gy) && this.pos.y <= gy) {
        this.pos.y = gy;
        this.flyVel.y = this.flyVel.y < -2 ? -this.flyVel.y * 0.3 : 0;
        const bleed = Math.max(0, 1 - 4 * dt);
        this.flyVel.x *= bleed;
        this.flyVel.z *= bleed;
      }
      if (this.flyVel.lengthSq() < 0.36 && this.pos.y <= gy + 0.05) {
        this.flyVel.set(0, 0, 0);
        this.airborneBy = null;
      }
      this.group.position.copy(this.pos);
    }
    for (const c of candidates) {
      if (!c.alive || c.id === this.airborneBy) {continue;}
      const r = FLAG_PICKUP_R * c.pickupScale;
      if (c.pos.distanceToSquared(this.pos) > r * r) {continue;}
      this.state = 'carried';
      this.carrier = c.id;
      this.airborneBy = null; this.flyVel.set(0, 0, 0);
      this.holdAcc = 0;
      this.announce(c.id === 'local' ? 'YOU ARE THE RABBIT' : `${c.id.replace('bot:', '')} IS THE RABBIT`);
      return;
    }
  }

  /** Per-frame through-terrain marker — same diamond the CTF flags get,
   *  anchored above the pole finial. Call after update(). */
  tickIndicator(): void {
    if (this.state === 'unspawned') {return;}
    _indAnchor.set(this.group.position.x, this.group.position.y + 3.4, this.group.position.z);
    this.d.lazyHud().updateFlagIndicator('flag:rabbit', _indAnchor, this.d.lazyCamera(), 'rabbit');
  }

  /** Bot brain objective — hunters run at the loose flag or the rabbit;
   *  the rabbit itself gets none (its combat/kite logic takes over). */
  goalFor(id: string, posOf: (id: string) => THREE.Vector3 | null): THREE.Vector3 | null {
    if (this.state === 'unspawned' || this.carrier === id) {return null;}
    if (this.state === 'dropped') {return this.pos;}
    return posOf(this.carrier!);
  }

  reset(): void {
    this.state = 'unspawned';
    this.carrier = null;
    this.holdAcc = 0;
    this.flyVel.set(0, 0, 0);
    this.airborneBy = null;
    this.group.visible = false;
    this.d.lazyHud().removePlayerIndicator('flag:rabbit');
  }

  dispose(): void {
    this.d.lazyHud().removePlayerIndicator('flag:rabbit');
    this.d.lazyScene().remove(this.group);
  }
}
