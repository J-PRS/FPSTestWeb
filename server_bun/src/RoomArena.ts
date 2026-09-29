/**
 * RoomArena — the dome barrier enforcement layer. The client renders the
 * shell itself; this sim watches positions and pushes violators back
 * inside. Contact is a shove, not a wall: the player keeps momentum and
 * can skate the rim, which feels like sliding on the barrier rather than
 * teleporting. Bots respect it implicitly (their roam targets come from
 * inside the arena).
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';

const PUSH_INTERVAL_S = 0.5;   // how often an offender gets re-shoved
const PUSH_FORCE = 40;         // inward impulse strength
const GRACE_OUTSIDE_S = 1.5;   // brief spillover (knockback through it) before pushback

export class RoomArena {
  private outsideSince = new Map<string, number>();

  constructor(
    private room: Room,
    private arena: { x: number; z: number; radius: number },
  ) {}

  tick(_dt: number): void {
    const { x: cx, z: cz, radius: r } = this.arena;
    const now = Date.now() / 1000;
    for (const p of this.room.players.getAllPlayers().values()) {
      if (p.isDead) { this.outsideSince.delete(p.id); continue; }
      const dx = p.position.x - cx, dz = p.position.z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= r) { this.outsideSince.delete(p.id); continue; }
      const since = this.outsideSince.get(p.id);
      if (since === undefined) { this.outsideSince.set(p.id, now); continue; }
      if (now - since < GRACE_OUTSIDE_S) continue;
      // Pull toward the dome center — knockback semantics push AWAY from
      // `position`, so a rim-anchored shove would launch offenders further
      // out. pull:true draws them inward instead. The shadow must eat the
      // same impulse or its trajectory diverges from the client's real one.
      const inv = 1 / (d || 1);
      const center: Vec3 = { x: cx, y: p.position.y, z: cz };
      this.room.connections.sendToPlayer(p.id, {
        type: 'knockback', targetId: p.id, position: center, force: PUSH_FORCE, pull: true,
      } as Parameters<Room['broadcast']>[0]);
      this.room.moveSim.applyImpulse(p.id, { x: -dx * inv * PUSH_FORCE, y: PUSH_FORCE * 0.3, z: -dz * inv * PUSH_FORCE });
      this.outsideSince.set(p.id, now + PUSH_INTERVAL_S);
    }
  }
}
