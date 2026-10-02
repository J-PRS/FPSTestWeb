import * as THREE from 'three';
import { releaseProjectileInstance, syncProjectileInstance } from './visuals.js';
import type { ProjectileConfig } from './types.js';
import type { Targetable } from '../entities/balls.js';

/**
 * ProjStuck — the planted-shell family: sticky glue attachment (rides a
 * live victim at a fixed offset) and the javelin-style embed corpse
 * (holds at the swept contact point, then shrinks away). Both are
 * "motion off, fuse still burning" states layered over the same shell.
 */

const _velDir = new THREE.Vector3();
const _FORWARD = new THREE.Vector3(0, 0, 1);
const EMBED_DEPTH = 0.4;
const EMBED_SHRINK_TIME = 0.25;

export interface StuckHost {
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  hitPoint: THREE.Vector3;
  hitPointValid: boolean;
  hitBall: Targetable | null;
  hitPlayerId: string | null;
  hitBolt: unknown;
  readonly config: ProjectileConfig;
  age: number;
  exploded: boolean;
  stuck: boolean;
  mesh: THREE.Mesh;
  scene: THREE.Scene;
  glowMesh: THREE.Mesh | null;
  updateMesh(): void;
  explode(): void;
  fuseTtl(): number | undefined;
}

export class ProjStuck {
  // Embed (javelin): world hit planted the shell — it holds at the
  // contact point for config.embeds seconds, then shrinks away. Combat
  // already resolved via explode(); this is purely the visible corpse.
  embedded = false;
  private embedAge = 0;

  // Stick attachment: a bomb glued to a victim rides it at a fixed
  // world-space offset (no victim-local frame — fine for spheres/capsules).
  private stuckTo: Targetable | null = null;
  private stuckPlayerId: string | null = null;
  private stuckMap: Map<string, THREE.Vector3> | null = null;
  private readonly stuckOffset = new THREE.Vector3();

  constructor(private h: StuckHost) {}

  /** Plant the bomb at a contact point — motion and sweeps stop, the
   *  fuse doesn't. With a victim it tracks; without one it just hangs. */
  stickAt(p: THREE.Vector3, ball?: Targetable, playerId?: string,
          remotePlayers?: Map<string, THREE.Vector3>): void {
    const h = this.h;
    h.stuck = true;
    h.pos.copy(p);
    h.prevPos.copy(p);
    h.vel.set(0, 0, 0);
    this.stuckTo = ball ?? null;
    this.stuckPlayerId = playerId ?? null;
    this.stuckMap = remotePlayers ?? null;
    const anchor = ball ? ball.pos : (playerId && remotePlayers?.get(playerId));
    if (anchor) this.stuckOffset.copy(p).sub(anchor);
    h.updateMesh();
  }

  // Stuck-bomb tick. No physics, no collision — only the fuse timer. A
  // bomb glued to a live mover RIDES it (world-space offset from
  // contact) — freezing in place while the victim jets away reads as a
  // miss, not a hit. Returns true while still glued (caller returns).
  tickStuck(): boolean {
    const h = this.h;
    const anchor = this.stuckTo ? (this.stuckTo.dead ? null : this.stuckTo.pos)
      : this.stuckPlayerId ? (this.stuckMap?.get(this.stuckPlayerId) ?? null)
      : null;
    if (this.stuckTo || this.stuckPlayerId) {
      if (anchor) {
        h.pos.copy(anchor).add(this.stuckOffset);
        h.prevPos.copy(h.pos);
        h.hitPoint.copy(h.pos); // blast follows the ride, not the contact point
      } else {
        // Victim died/despawned under the bomb — it lets go and falls.
        h.stuck = false;
        this.stuckTo = null;
        this.stuckPlayerId = null;
      }
    }
    if (!h.stuck) return false; // dropped — fall through into physics with zero velocity
    if (h.fuseTtl() && h.age >= h.fuseTtl()!) h.explode();
    else h.updateMesh();
    return true;
  }

  /** Explode-time embed check: world-hit + embeds config + no victim —
   *  plants the shell as a planted corpse. Returns true when handled. */
  tryEmbed(): boolean {
    const h = this.h;
    if (h.config.embeds === undefined || !h.hitPointValid
        || h.hitBall || h.hitPlayerId || h.hitBolt) return false;
    this.embedded = true;
    this.embedAge = 0;
    // Tip-origin mesh: slide only a little along the flight line — the
    // head buries, ~1.6m of tail stays visibly planted in the dirt.
    // hitPoint itself stays at the swept contact — the impact decal
    // and blast position still read from it.
    h.pos.copy(h.hitPoint);
    if (h.vel.lengthSq() > 0.01) {
      _velDir.copy(h.vel).normalize();
      h.pos.addScaledVector(_velDir, EMBED_DEPTH);
      h.mesh.quaternion.setFromUnitVectors(_FORWARD, _velDir);
    }
    h.prevPos.copy(h.pos);
    // vel kept: the impact effect reads it this same frame to orient
    // the flash + kick sparks back along the shot line.
    h.mesh.position.copy(h.pos);
    h.mesh.scale.setScalar(1);
    syncProjectileInstance(h.mesh);
    if (h.glowMesh) { releaseProjectileInstance(h.glowMesh); h.glowMesh = null; }
    return true;
  }

  // Planted shell: hold full size for the embed window, then shrink away.
  tickEmbedded(dt: number): boolean { // true while the corpse is still planted
    const h = this.h;
    this.embedAge += dt;
    const shrink = (this.embedAge - h.config.embeds!) / EMBED_SHRINK_TIME;
    if (shrink >= 1) return false; // caller removes the mesh
    if (shrink > 0) { h.mesh.scale.setScalar(1 - shrink); syncProjectileInstance(h.mesh); }
    return true;
  }
}
