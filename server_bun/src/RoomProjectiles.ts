/**
 * Server-side ballistic sim — bots-as-legal-players phase 2.
 *
 * A bot fire no longer means "broadcast a tracer, roll damage". It spawns
 * a real projectile the room integrates through shared/projSim.ts: swept
 * segment vs the heightfield and every live player's capsule, then damage
 * through the same CombatHandler funnels a client's validated claim uses
 * (applyHit → kill credit, weapon attribution, friendly gate, respawn).
 *
 * Clients render the replica off the existing projectileCreated /
 * projectileDestroyed pair — remote projectiles already fly
 * deterministically client-side, so nothing new is needed there.
 *
 * Deliberate simplifications vs the client Projectile: no terrain bounce
 * (a server shell pops on contact — bounces are cosmetic anyway since
 * clients resolve their own arcs), no stickies, no ray-burst. Bots don't
 * carry those weapons yet; add them when loadouts land (phase 4).
 */
import { projStep, segFieldHit, segPointDist, type SimProjectile } from '../../shared/projSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { PLAYER_RADIUS } from '../../shared/constants.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { hitRadiusAt } from '../../shared/combat.ts';
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';

interface LiveProj {
  id: string;
  ownerId: string;
  weaponType: number;
  p: SimProjectile;
}

// Player aim height — matches where the client sweeps the capsule center.
const CHEST_Y = 1.0;
// Failsafe TTL for weapons that forgot a fuse — nothing should orbit forever.
const HARD_TTL_S = 8;
// Below this altitude the shell is irrecoverably underground / off-map.
const FLOOR_Y = -220;

export class RoomProjectiles {
  private readonly room: Room;
  private readonly field: Heightfield | null;
  private projs = new Map<string, LiveProj>();
  private nextId = 1;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
  }

  /** Fire a real projectile. `dir` is normalized; muzzle velocity = dir*speed
   *  + 50% of the shooter's velocity (same inheritance the client applies). */
  spawn(ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3): string | null {
    const stats = getWeaponStats(weaponType);
    if (!stats || stats.speed <= 0) return null; // hitscan-class — no body
    const owner = this.room.players.getPlayer(ownerId);
    if (!owner) return null;
    const id = `sp-${this.nextId++}`;
    const vel: Vec3 = {
      x: dir.x * stats.speed + ownerVel.x * 0.5,
      y: dir.y * stats.speed + ownerVel.y * 0.5,
      z: dir.z * stats.speed + ownerVel.z * 0.5,
    };
    this.projs.set(id, { id, ownerId, weaponType, p: { pos: { ...origin }, vel, age: 0 } });
    this.room.broadcast({
      type: 'projectileCreated', projectileId: id, ownerId,
      position: { ...origin }, velocity: vel, weaponType,
    });
    return id;
  }

  tick(dt: number): void {
    // Map iterators tolerate mid-loop delete (detonate) — no snapshot.
    for (const proj of this.projs.values()) {
      const stats = getWeaponStats(proj.weaponType);
      const p = proj.p;
      const from = projStep(p, dt, stats.gravity);
      const ttl = stats.maxLifetime ?? HARD_TTL_S;
      if (p.age >= ttl || p.pos.y < FLOOR_Y) { this.detonate(proj, { ...p.pos }); continue; }

      // Terrain contact — server shells pop on first contact; the client's
      // own bounce arc diverges cosmetically, never in damage outcome.
      if (this.field) {
        const hit = segFieldHit(from, p.pos, this.field);
        if (hit) { this.detonate(proj, hit); continue; }
      }

      // Player sweep — same legal radius the hit-claim validator allows:
      // capsule radius + the larger of body/wake radius at this airtime.
      const reach = PLAYER_RADIUS + Math.max(stats.bodyRadius, hitRadiusAt(proj.weaponType, p.age));
      let hitId: string | null = null;
      for (const [pid, target] of this.room.players.getAllPlayers()) {
        if (pid === proj.ownerId || target.isDead) continue;
        const center = { x: target.position.x, y: target.position.y + CHEST_Y, z: target.position.z };
        if (segPointDist(from, p.pos, center) <= reach) { hitId = pid; break; }
      }
      if (hitId !== null) this.detonate(proj, { ...p.pos }, hitId);
      // No contact — still flying; survives to the next tick.
    }
  }

  private detonate(proj: LiveProj, at: Vec3, directHitId?: string | null): void {
    this.projs.delete(proj.id);
    this.room.broadcast({ type: 'projectileDestroyed', projectileId: proj.id });
    if (directHitId) this.room.messages.botAttack(proj.ownerId, directHitId, proj.weaponType);
    this.room.messages.serverBlast(proj.ownerId, at, proj.weaponType, directHitId ?? null);
  }

  /** Drop an owner's live shells — disconnect/reap cleanup like the
   *  client-side destroy path. */
  clearOwner(ownerId: string): void {
    for (const [id, proj] of this.projs) {
      if (proj.ownerId === ownerId) {
        this.projs.delete(id);
        this.room.broadcast({ type: 'projectileDestroyed', projectileId: id });
      }
    }
  }
}
