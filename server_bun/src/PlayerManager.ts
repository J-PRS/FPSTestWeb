import type { PlayerState, Vec3, Rotation, GameStatePlayer } from './types.ts';
import { CONFIG } from './config.ts';

let internalIdCounter = 0;

function nextInternalId(): string {
  return `${Date.now()}_${++internalIdCounter}`;
}

export class PlayerManager {
  private players: Map<string, PlayerState> = new Map();

  addPlayer(playerId: string): PlayerState {
    const spawn = this.pickSpawnPoint(playerId);

    const player: PlayerState = {
      id: playerId,
      internalId: nextInternalId(),
      position: { ...spawn },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: CONFIG.playerMaxHealth,
      isDead: false,
      kills: 0,
      deaths: 0,
      lastSeen: Date.now(),
      pendingRespawn: false,
    };

    this.players.set(playerId, player);
    return player;
  }

  removePlayer(playerId: string): PlayerState | undefined {
    const player = this.players.get(playerId);
    if (player) {
      this.players.delete(playerId);
    }
    return player;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  getAllPlayers(): Map<string, PlayerState> {
    return this.players;
  }

  getOtherPlayers(playerId: string): PlayerState[] {
    const others: PlayerState[] = [];
    for (const [id, p] of this.players) {
      if (id !== playerId) {
        others.push(p);
      }
    }
    return others;
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  toGameStatePlayer(player: PlayerState): GameStatePlayer {
    return {
      id: player.id,
      internalId: player.internalId,
      position: { ...player.position },
      rotation: { ...player.rotation },
      velocity: { ...player.velocity },
      isDead: player.isDead,
      health: player.health,
    };
  }

  updatePosition(playerId: string, position: Vec3, rotation: Rotation, velocity: Vec3): void {
    const player = this.players.get(playerId);
    if (player) {
      player.position = { ...position };
      player.rotation = { ...rotation };
      player.velocity = { ...velocity };
      player.lastSeen = Date.now();
    }
  }

  applyDamage(targetId: string, damage: number): { killed: boolean; newHealth: number } {
    const target = this.players.get(targetId);
    if (!target || target.isDead) {
      return { killed: false, newHealth: 0 };
    }

    target.health -= damage;
    if (target.health <= 0) {
      target.health = 0;
      target.isDead = true;
      target.deaths++;
      target.pendingRespawn = true;
      return { killed: true, newHealth: 0 };
    }

    return { killed: false, newHealth: target.health };
  }

  respawnPlayer(playerId: string): { position: Vec3; rotation: Rotation } | null {
    const player = this.players.get(playerId);
    if (!player) return null;

    const spawn = this.pickSpawnPoint(playerId);
    player.position = { ...spawn };
    player.rotation = { yaw: 0, pitch: 0 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.health = CONFIG.playerMaxHealth;
    player.isDead = false;
    player.pendingRespawn = false;

    return { position: { ...player.position }, rotation: { ...player.rotation } };
  }

  addKill(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.kills++;
    }
  }

  private pickSpawnPoint(playerId: string): Vec3 {
    const points: Vec3[] = CONFIG.spawnPoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    if (this.players.size === 0) {
      return { ...points[0]! };
    }

    let best: Vec3 = { ...points[0]! };
    let maxMinDist = -1;

    for (const spawn of points) {
      let minDist = Infinity;
      for (const [id, p] of this.players) {
        if (id === playerId || p.isDead) continue;
        const dx = spawn.x - p.position.x;
        const dz = spawn.z - p.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDist) minDist = dist;
      }
      if (minDist > maxMinDist) {
        maxMinDist = minDist;
        best = { ...spawn };
      }
    }

    return best;
  }
}
