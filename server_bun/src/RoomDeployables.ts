/**
 * RoomDeployables — server-authoritative placed structures (sentry turret,
 * proximity mine, resupply station, patrol drone). The client owns aiming
 * and FX; the server owns existence: a `deploy` claim registers the object,
 * the room broadcasts it, and the sim enforces per-player caps, TTL, and
 * teardown on death/leave/match-reset. Without this layer a cheater could
 * carpet the map — there was previously no server record at all.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

export type DeployKind = 'turret' | 'mine' | 'station' | 'drone';
const KINDS = new Set<DeployKind>(['turret', 'mine', 'station', 'drone']);
const MAX_PER_PLAYER: Record<DeployKind, number> = { turret: 2, mine: 6, station: 1, drone: 2 };
const TTL_S: Record<DeployKind, number> = { turret: 180, mine: 120, station: 240, drone: 90 };
// Plants near the action are legit; plants across the map are not.
const MAX_PLANT_DIST = 40;

interface Deployed {
  id: number;
  owner: string;
  kind: DeployKind;
  pos: Vec3;
  ttl: number;
}

export class RoomDeployables {
  private items = new Map<number, Deployed>();
  private nextId = 1;

  constructor(private room: Room) {}

  /** Client claims a plant. Validates kind, per-player cap, and that the
   *  drop point is near the planter — the deploy anim throws the pod a few
   *  meters, not across the map. */
  handleDeploy(playerId: string, kind: string, pos: Vec3): void {
    const player = this.room.players.getPlayer(playerId);
    if (!player || player.isDead || !KINDS.has(kind as DeployKind)) return;
    const k = kind as DeployKind;
    const dx = pos.x - player.position.x, dy = pos.y - player.position.y, dz = pos.z - player.position.z;
    if (dx * dx + dy * dy + dz * dz > MAX_PLANT_DIST * MAX_PLANT_DIST) return;
    const owned = [...this.items.values()].filter((d) => d.owner === playerId && d.kind === k);
    // At cap: recycle the oldest rather than refuse — Tribes remote-arms
    // behavior, keeps the feel without an unbounded pile.
    if (owned.length >= MAX_PER_PLAYER[k]) {
      owned.sort((a, b) => a.ttl - b.ttl);
      this.remove(owned[0]!.id);
    }
    const id = this.nextId++;
    this.items.set(id, { id, owner: playerId, kind: k, pos: { ...pos }, ttl: TTL_S[k] });
    this.room.broadcast({ type: 'deploySpawn', id, owner: playerId, kind: k, pos: { ...pos }, team: player.team } as ServerMessage);
  }

  /** Owner death clears their field — no orphaned turrets farming kills
   *  for a corpse. Match reset and player leave use the same path. */
  clearOwner(ownerId: string): void {
    for (const d of [...this.items.values()]) {
      if (d.owner === ownerId) this.remove(d.id);
    }
  }

  clearAll(): void {
    for (const id of this.items.keys()) this.remove(id);
  }

  snapshot(): { id: number; owner: string; kind: DeployKind; pos: Vec3 }[] {
    return [...this.items.values()].map((d) => ({ id: d.id, owner: d.owner, kind: d.kind, pos: { ...d.pos } }));
  }

  private remove(id: number): void {
    if (!this.items.delete(id)) return;
    this.room.broadcast({ type: 'deployGone', id } as ServerMessage);
  }

  tick(dt: number): void {
    if (this.items.size === 0) return;
    for (const d of [...this.items.values()]) {
      d.ttl -= dt;
      if (d.ttl <= 0) this.remove(d.id);
    }
  }
}
