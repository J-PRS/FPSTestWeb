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
  fireCd: number;
}

// Sentry combat envelope — mirrors the client DeployTurret constants so
// the server sim and the visual agree on what the gun can reach.
const TURRET_RANGE = 42;
const TURRET_FIRE_INTERVAL = 1.25;
const TURRET_DAMAGE = 14;
const TURRET_UNFOLD_S = 0.45;

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
    this.items.set(id, { id, owner: playerId, kind: k, pos: { ...pos }, ttl: TTL_S[k], fireCd: TURRET_UNFOLD_S + Math.random() * 0.4 });
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
      if (d.ttl <= 0) { this.remove(d.id); continue; }
      if (d.kind === 'turret') this.tickTurret(d, dt);
    }
  }

  /** Server-side sentry fire: nearest hostile player in the envelope gets
   *  a bolt every TURRET_FIRE_INTERVAL. Damage rides the shared funnel so
   *  kill credit, spawn protection and respawn all behave — the client
   *  visual layer shows the matching rocket via the turretShot broadcast. */
  private tickTurret(d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) return;
    const owner = this.room.players.getPlayer(d.owner);
    let target: string | null = null;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    for (const [pid, p] of this.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) continue;
      if (owner?.team && p.team === owner.team) continue;
      if (p.protectedUntil > Date.now()) continue;
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; target = pid; }
    }
    if (!target) { d.fireCd = Math.min(d.fireCd + 0.15, 0.15); return; } // idle scan: cheap re-check
    d.fireCd = TURRET_FIRE_INTERVAL;
    this.room.broadcast({ type: 'turretShot', id: d.id, owner: d.owner, targetId: target } as ServerMessage);
    this.room.messages.turretAttack(d.owner, target, TURRET_DAMAGE);
  }
}
