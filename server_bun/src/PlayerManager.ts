import type { PlayerState, Vec3, Rotation, GameStatePlayer } from './types.ts';
import { CONFIG } from './config.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { POWERUP } from '../../shared/pickups.ts';
import { ENERGY } from '../../shared/movement.ts';

let internalIdCounter = 0;

function nextInternalId(): string {
  return `${Date.now()}_${++internalIdCounter}`;
}

export class PlayerManager {
  private players: Map<string, PlayerState> = new Map();
  /** Spawn anchors — map specs override, default is the config ring. */
  spawnPoints: Vec3[] | null = null;
  /** Spawn protection window — long enough to orient, short enough that
   *  camping a spawn ring still works. */
  static readonly SPAWN_PROTECT_MS = 2000;

  /** Team home bases — when set, team members spawn near their own flag
   *  instead of the generic farthest-from-everyone ring. */
  teamBases: { alpha: Vec3; bravo: Vec3 } | null = null;

  /** Sink for energy burns the sim must mirror — shield soak in
   *  applyDamage burns the move shadow's modeled tank. Room wires it. */
  energyBurn?: (playerId: string, energy: number) => void;

  addPlayer(playerId: string, team?: 'alpha' | 'bravo', perk: string = 'none'): PlayerState {
    const spawn = this.pickSpawnPoint(playerId, team);
    const maxHealth = CONFIG.playerMaxHealth + perkMods(perk).maxHealth;

    const player: PlayerState = {
      id: playerId,
      internalId: nextInternalId(),
      position: { ...spawn },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: maxHealth,
      perk,
      maxHealth,
      isDead: false,
      team,
      kills: 0,
      deaths: 0,
      streak: 0,
      lastSeen: Date.now(),
      pendingRespawn: false,
      lastSeq: 0,
      lastValidPosition: { ...spawn },
      lastValidVelocity: { x: 0, y: 0, z: 0 },
      lastValidRotation: { yaw: 0, pitch: 0 },
      hasReceivedPosition: false,
      lastPosCheckTime: 0,
      lastPosCheckPos: { ...spawn },
      consecutiveRejects: 0,
      correctionGraceUntil: 0,
      ping: 0,
      skiing: 0,
      status: 0,
      history: [],
      forceSendUntil: 0,
      protectedUntil: Date.now() + PlayerManager.SPAWN_PROTECT_MS,
      healCredit: 0,
      armor: 0,
      regenUntil: 0,
      ddUntil: 0,
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

  /** Drop the spawn shield — firing calls this; tests use it to reach
   *  the damage path without sleeping 2s. */
  breakShield(playerId: string): void {
    const p = this.players.get(playerId);
    if (p) p.protectedUntil = 0;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  /** Mid-match team swap — callers broadcast teamUpdate. */
  setTeam(playerId: string, team: 'alpha' | 'bravo'): void {
    const p = this.players.get(playerId);
    if (p) p.team = team;
  }

  /** Live player counts per team. */
  teamCounts(): { alpha: number; bravo: number } {
    let alpha = 0, bravo = 0;
    for (const p of this.players.values()) {
      if (p.team === 'alpha') alpha++;
      else if (p.team === 'bravo') bravo++;
    }
    return { alpha, bravo };
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

  /** Humans only — server bots don't keep a match alive on their own. */
  getHumanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
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
      status: player.status,
      team: player.team,
      transport: player.transport,
    };
  }

  updatePosition(playerId: string, position: Vec3, rotation: Rotation, velocity: Vec3, seq?: number): void {
    const player = this.players.get(playerId);
    if (player) {
      player.position = { ...position };
      player.rotation = { ...rotation };
      player.velocity = { ...velocity };
      player.lastSeen = Date.now();
      if (seq !== undefined && seq > player.lastSeq) {
        player.lastSeq = seq;
        player.lastValidPosition = { ...position };
        player.lastValidVelocity = { ...velocity };
        player.lastValidRotation = { ...rotation };
      }
    }
  }

  getLastSeq(playerId: string): number {
    const player = this.players.get(playerId);
    return player?.lastSeq ?? 0;
  }

  getLastValidState(playerId: string): { position: Vec3; velocity: Vec3; rotation: Rotation; seq: number } | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    return {
      position: { ...player.lastValidPosition },
      velocity: { ...player.lastValidVelocity },
      rotation: { ...player.lastValidRotation },
      seq: player.lastSeq,
    };
  }

  applyDamage(targetId: string, damage: number): { killed: boolean; newHealth: number; newArmor: number } {
    const target = this.players.get(targetId);
    if (!target || target.isDead) {
      return { killed: false, newHealth: 0, newArmor: 0 };
    }
    if (Date.now() < target.protectedUntil) {
      return { killed: false, newHealth: target.health, newArmor: target.armor };
    }
    // Energy shield: while the flag is up the hit routes to the player's
    // energy tank, not their health — the client drains dmg/10 energy and
    // drops the flag when the pool bottoms out (inputMove carries it).
    if (target.status & STATUS.SHIELD) {
      this.energyBurn?.(targetId, damage / ENERGY.shieldDmgPerEnergy);
      return { killed: false, newHealth: target.health, newArmor: target.armor };
    }

    // Perk damage resist — the join-declared table owns the modifier,
    // the server applies it so the number can't be client-inflated.
    let incoming = damage * (1 - perkMods(target.perk).damageResist);
    // Armor pool: absorbs armorAbsorb of the hit while it lasts, overflow
    // leaks to health (100hp/100armor taking 100 → 80hp/20armor).
    if (target.armor > 0) {
      const soaked = Math.min(target.armor, incoming * POWERUP.armorAbsorb);
      target.armor -= soaked;
      incoming -= soaked;
    }
    target.health -= incoming;
    if (target.health <= 0) {
      target.health = 0;
      target.isDead = true;
      target.status = 0; // death strips every channel — a cloaked/mending corpse is a lie
      target.deaths++;
      target.pendingRespawn = true;
      target.armor = 0;
      target.regenUntil = 0;
      target.ddUntil = 0;
      return { killed: true, newHealth: 0, newArmor: 0 };
    }

    return { killed: false, newHealth: target.health, newArmor: target.armor };
  }

  respawnPlayer(playerId: string): { position: Vec3; rotation: Rotation } | null {
    const player = this.players.get(playerId);
    if (!player) return null;

    const spawn = this.pickSpawnPoint(playerId, player.team);
    player.position = { ...spawn };
    player.rotation = { yaw: 0, pitch: 0 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.health = player.maxHealth;
    player.isDead = false;
    player.status = 0; // a corpse carries no channels — toggles died with them
    player.armor = 0;
    player.regenUntil = 0;
    player.ddUntil = 0;
    player.pendingRespawn = false;
    player.lastSeq = 0;
    player.lastValidPosition = { ...spawn };
    player.lastValidVelocity = { x: 0, y: 0, z: 0 };
    player.lastValidRotation = { yaw: 0, pitch: 0 };
    player.hasReceivedPosition = false;
    player.lastPosCheckTime = 0;
    player.lastPosCheckPos = { ...spawn };
    player.consecutiveRejects = 0;
    // Rewind buffer: corpse-side samples must not survive the respawn —
    // hit validation and muzzle checks would rewind to the death site.
    player.history.length = 0;
    player.history.push({ t: Date.now(), x: spawn.x, y: spawn.y, z: spawn.z });
    player.protectedUntil = Date.now() + PlayerManager.SPAWN_PROTECT_MS;

    return { position: { ...player.position }, rotation: { ...player.rotation } };
  }

  /** Fresh match — wipe everyone's K/D so the journal records per-match
   *  stats, not career totals. */
  resetStats(): void {
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.streak = 0; }
  }

  /** Total kills across the roster — `=== 1` exactly at a match's first kill
   *  (resetStats zeroes the table, so it can't lag a match boundary). */
  killTotal(): number {
    let n = 0;
    for (const p of this.players.values()) n += p.kills;
    return n;
  }

  addKill(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.kills++;
    }
  }

  private pickSpawnPoint(playerId: string, team?: 'alpha' | 'bravo'): Vec3 {
    const points: Vec3[] = (this.spawnPoints ?? CONFIG.spawnPoints).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    if (this.players.size === 0) {
      return { ...points[0]! };
    }

    // Team modes prefer own-base spawns — materializing among enemies is
    // instant camp food. Score blends base proximity with enemy clearance.
    const base = team === 'alpha' || team === 'bravo' ? this.teamBases?.[team] : undefined;
    let best: Vec3 = { ...points[0]! };
    let bestScore = -Infinity;

    for (const spawn of points) {
      let minFoeDist = Infinity;
      for (const [id, p] of this.players) {
        if (id === playerId || p.isDead) continue;
        // Teammates near a spawn are safety, not a threat.
        if (base && p.team && p.team === team) continue;
        const dx = spawn.x - p.position.x;
        const dz = spawn.z - p.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minFoeDist) minFoeDist = dist;
      }
      if (minFoeDist === Infinity) minFoeDist = 0;
      const score = base
        ? minFoeDist - 2 * Math.hypot(spawn.x - base.x, spawn.z - base.z)
        : minFoeDist;
      if (score > bestScore) {
        bestScore = score;
        best = { ...spawn };
      }
    }

    return best;
  }
}
