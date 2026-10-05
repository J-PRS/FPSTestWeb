import * as THREE from 'three';

import { FLAG_PICKUP_R } from '../../../shared/teams.js';

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
  private readonly group = new THREE.Group();

  constructor(
    private d: {
      lazyScene(): THREE.Scene;
      lazyTerrain(): { getHeight(x: number, z: number): number };
    },
    private announce: (text: string) => void,
  ) {
    // Neutral gold — not either team's color, since the rabbit is FFA.
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6),
      new THREE.MeshLambertMaterial({ color: 0x888888 }),
    );
    pole.position.y = 1.3;
    const pennant = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 1.4, 4),
      new THREE.MeshLambertMaterial({ color: 0xffcc44, emissive: 0x664400 }),
    );
    pennant.position.y = 2.9;
    pennant.rotation.x = Math.PI;
    this.group.add(pole, pennant);
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
    this.pos.set(pos.x, this.d.lazyTerrain().getHeight(pos.x, pos.z), pos.z);
    this.group.position.copy(this.pos);
    this.group.visible = true;
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
    for (const c of candidates) {
      if (!c.alive) {continue;}
      const r = FLAG_PICKUP_R * c.pickupScale;
      if (c.pos.distanceToSquared(this.pos) > r * r) {continue;}
      this.state = 'carried';
      this.carrier = c.id;
      this.holdAcc = 0;
      this.announce(c.id === 'local' ? 'YOU ARE THE RABBIT' : `${c.id.replace('bot:', '')} IS THE RABBIT`);
      return;
    }
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
    this.group.visible = false;
  }

  dispose(): void {
    this.d.lazyScene().remove(this.group);
  }
}
