import type { PlayerState, Vec3, Rotation, GameStatePlayer } from './types.ts';
import { CONFIG } from './config.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods, effectiveResist } from '../../shared/perks.ts';
import { CLASS_STATS } from '../../shared/botClasses.ts';
import { POWERUP } from '../../shared/pickups.ts';
import { BELT_MAX } from '../../shared/weapons.ts';
import { ENERGY } from '../../shared/movement.ts';
import { WORLD_MODEL, rosterRow } from '../../shared/worldModel.ts';
import { SpawnPicker } from './spawnPicker.ts';
import type { SpawnPoint } from '../../shared/mapSpec.ts';
import type { TeamId } from '../../shared/teams.ts';
import { SPAWN_PROTECT_MS } from '../../shared/constants.ts';
import { simNow, simMs } from './simClock.ts';
import { wallNow, wallMs } from './wallClock.ts';

let internalIdCounter = 0;

function nextInternalId(): string {
  return `${wallNow()}_${++internalIdCounter}`;
}

export class PlayerManager {
  private players: Map<string, PlayerState> = new Map();
  // Kept as a counter, not a scan — Room.empty asks every room every tick.
  private humans = 0;
  /** Spawn anchors — map specs override, default is the config ring. */
  spawnPoints: SpawnPoint[] | null = null;
  /** Team-owned spawn spheres from the map spec — when set, team members
   *  spawn inside their own sphere volumes (T2 SpawnSphere semantics). */
  teamSpawns: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] } | null = null;
  /** Spawn jitter source — Room wires its seeded rng so soaks/tests can
   *  reproduce a spawn layout. */
  spawnRng: () => number = Math.random;

  /** Team home bases — when set, team members spawn near their own flag
   *  instead of the generic farthest-from-everyone ring. */
  teamBases: { alpha: Vec3; bravo: Vec3 } | null = null;

  /** Sink for energy burns the sim must mirror — shield soak in
   *  applyDamage burns the move shadow's modeled tank. Room wires it. */
  energyBurn?: (playerId: string, energy: number) => void;

  /** Ground height at (x,z) — Room wires its live heightfield. Spawn
   *  anchors are authored data: a point buried under the terrain lifts to
   *  the surface instead of spawning a player inside the ground. */
  groundAt?: (x: number, z: number) => number;

  /** Room wires the bot roster here — posted roles get a strong pull
   *  toward the home sphere so they respawn at the stand they're meant
   *  to hold. Must return undefined (not 0) for unaffiliated ids — the
   *  picker's `homeBias ?? (teamPool ? 0 : 2)` fallback only engages on
   *  undefined, and humans rely on that own-base pull on maps that ship
   *  a flat `spawns` list (bastion: the flat-pool foe-clearance pick
   *  once dropped joins on the far base). */
  spawnHomeBias?: (playerId: string) => number | undefined;
  /** A tasked member's job position — when set, spawn scoring pulls
   *  toward the task instead of the home sphere (a wave member who
   *  respawns at base just re-runs the lethal transit). */
  spawnObjective?: (playerId: string) => { pos: Vec3; w: number } | null;

  private readonly spawnPicker = new SpawnPicker({
    players: () => this.players,
    spawnPoints: () => this.spawnPoints,
    teamSpawns: () => this.teamSpawns,
    teamBases: () => this.teamBases,
    homeBias: (id) => this.spawnHomeBias?.(id),
    objective: (id) => this.spawnObjective?.(id) ?? null,
    groundAt: () => this.groundAt,
    rng: () => this.spawnRng(),
  });

  addPlayer(playerId: string, team?: TeamId, perk: string = 'none', armorClass: string = 'medium', isBot = false): PlayerState {
    const spawn = this.spawnPicker.pick(playerId, team);
    const cls = armorClass === 'light' || armorClass === 'heavy' ? armorClass : 'medium';
    const maxHealth = CONFIG.playerMaxHealth + perkMods(perk).maxHealth + CLASS_STATS[cls].maxHealth;

    const player: PlayerState = {
      id: playerId,
      internalId: nextInternalId(),
      position: { ...spawn },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: maxHealth,
      perk,
      armorClass: cls,
      maxHealth,
      isDead: false,
      team,
      kills: 0,
      deaths: 0,
      streak: 0,
      lastSeen: wallNow(),
      pendingRespawn: false,
      lastSeq: 0,
      lastValidPosition: { ...spawn },
      lastValidVelocity: { x: 0, y: 0, z: 0 },
      lastValidRotation: { yaw: 0, pitch: 0 },
      hasReceivedPosition: false,
      joinAnnounced: false,
      lastPosCheckTime: wallMs(0),
      lastPosCheckPos: { ...spawn },
      consecutiveRejects: 0,
      correctionGraceUntil: wallMs(0),
      ping: 0,
      skiing: 0,
      jetting: 0,
      status: 0,
      lastFireSim: simMs(-Infinity),
      history: [],
      forceSendUntil: wallMs(0),
      protectedUntil: simMs(simNow() + SPAWN_PROTECT_MS),
      healCredit: 0,
      beltCharges: BELT_MAX,
      armor: 0,
      regenUntil: simMs(0),
      ddUntil: simMs(0),
      lastDamageAt: simMs(simNow()), // spawn counts as the ramp's t=0
      charge: 0,
      chargeT: 0,
      chargeEchoed: 0,
      chargeEchoAt: wallMs(0),
      healthEchoAt: wallMs(0),
    };

    // Bots stamp p.isBot after this returns — the counter must key on
    // the join call's own answer, not the field's late arrival.
    const was = this.players.get(playerId);
    if (was && !was.isBot) this.humans--;
    if (!isBot) this.humans++;
    this.players.set(playerId, player);
    return player;
  }

  removePlayer(playerId: string): PlayerState | undefined {
    const player = this.players.get(playerId);
    if (player) {
      if (!player.isBot) this.humans--;
      this.players.delete(playerId);
    }
    return player;
  }

  /** Drop the spawn shield — firing calls this; tests use it to reach
   *  the damage path without sleeping 2s. */
  breakShield(playerId: string): void {
    const p = this.players.get(playerId);
    if (p) p.protectedUntil = simMs(0);
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  /** Mid-match team swap — callers broadcast teamUpdate. */
  setTeam(playerId: string, team: TeamId): void {
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
    return this.humans;
  }

  toGameStatePlayer(player: PlayerState): GameStatePlayer {
    return rosterRow(WORLD_MODEL.player!, 'id', player.id, {
      name: player.name,
      internalId: player.internalId,
      position: { ...player.position },
      rotation: { ...player.rotation },
      velocity: { ...player.velocity },
      isDead: player.isDead,
      health: player.health,
      status: player.status,
      team: player.team,
      transport: player.transport,
      armorClass: player.armorClass,
    }) as unknown as GameStatePlayer;
  }

  updatePosition(playerId: string, position: Vec3, rotation: Rotation, velocity: Vec3, seq?: number): void {
    const player = this.players.get(playerId);
    // A stale/reordered report must not regress position — all lanes are
    // ordered now, but a replayed or duplicated packet would otherwise
    // teleport the player backward through plausible() checks.
    if (player && (seq === undefined || seq > player.lastSeq || player.lastSeq === 0)) {
      // Mutate in place — this is the server's hottest ingest (a spread
      // per field per report was steady GC churn); field-wise writes
      // also keep any alias of player.position coherent.
      player.position.x = position.x; player.position.y = position.y; player.position.z = position.z;
      player.rotation.yaw = rotation.yaw; player.rotation.pitch = rotation.pitch;
      player.velocity.x = velocity.x; player.velocity.y = velocity.y; player.velocity.z = velocity.z;
      player.lastSeen = wallNow();
      if (seq !== undefined && seq > player.lastSeq) {
        player.lastSeq = seq;
        player.lastValidPosition.x = position.x; player.lastValidPosition.y = position.y; player.lastValidPosition.z = position.z;
        player.lastValidVelocity.x = velocity.x; player.lastValidVelocity.y = velocity.y; player.lastValidVelocity.z = velocity.z;
        player.lastValidRotation.yaw = rotation.yaw; player.lastValidRotation.pitch = rotation.pitch;
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
    if (simNow() < target.protectedUntil) {
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
    let incoming = damage * (1 - effectiveResist(perkMods(target.perk), target.health, target.maxHealth));
    // Armor pool: absorbs armorAbsorb of the hit while it lasts, overflow
    // leaks to health (100hp/100armor taking 100 → 80hp/20armor).
    if (target.armor > 0) {
      const soaked = Math.min(target.armor, incoming * POWERUP.armorAbsorb);
      target.armor -= soaked;
      incoming -= soaked;
    }
    target.lastDamageAt = simMs(simNow()); // regenerator ramp resets on any hit that lands
    target.health -= incoming;
    if (target.health <= 0) {
      target.health = 0;
      target.isDead = true;
      target.status = 0; // death strips every channel — a cloaked/mending corpse is a lie
      target.skiing = 0; target.jetting = 0; // held keys die too — the wire bit can't outlive the body
      target.deaths++;
      target.pendingRespawn = true;
      target.armor = 0;
      target.regenUntil = simMs(0);
      target.ddUntil = simMs(0);
      // NOTE: `charge` survives the kill — applyHit pops the corpse's bank.
      return { killed: true, newHealth: 0, newArmor: 0 };
    }

    return { killed: false, newHealth: target.health, newArmor: target.armor };
  }

  respawnPlayer(playerId: string): { position: Vec3; rotation: Rotation; armorClass: string } | null {
    const player = this.players.get(playerId);
    if (!player) return null;

    // Banked classUpdate — the tier swap takes effect at the new life so
    // the sim scale and HP pool change at a declared discontinuity, never
    // mid-life.
    if (player.pendingClass && player.pendingClass !== player.armorClass) {
      const cls = player.pendingClass;
      player.armorClass = cls;
      player.maxHealth = CONFIG.playerMaxHealth + perkMods(player.perk).maxHealth + CLASS_STATS[cls].maxHealth;
    }
    player.pendingClass = undefined;

    // Banked perkUpdate — same respawn rule: the perk's HP pool, regen,
    // and jet economy re-derive here, never mid-life.
    if (player.pendingPerk && player.pendingPerk !== player.perk) {
      player.perk = player.pendingPerk;
      player.maxHealth = CONFIG.playerMaxHealth + perkMods(player.perk).maxHealth + CLASS_STATS[player.armorClass as keyof typeof CLASS_STATS].maxHealth;
    }
    player.pendingPerk = undefined;

    const spawn = this.spawnPicker.pick(playerId, player.team);
    player.position = { ...spawn };
    player.rotation = { yaw: 0, pitch: 0 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.health = player.maxHealth;
    player.isDead = false;
    player.status = 0; // a corpse carries no channels — toggles died with them
    player.skiing = 0; player.jetting = 0; // respawn waits for a fresh inputMove — stale held bits would broadcast a ghost key until then
    player.lastFireSim = simMs(-Infinity); // respawn is a fresh cloak, not the old one's reveal
    player.armor = 0;
    player.regenUntil = simMs(0);
    player.ddUntil = simMs(0);
    player.lastDamageAt = simMs(simNow()); // a fresh life is a fresh ramp
    player.charge = 0;
    player.beltCharges = BELT_MAX;
    player.pendingRespawn = false;
    // lastSeq survives: the client's frame counter is monotone per
    // connection, and zeroing it re-opens the seq gate to stale
    // pre-death frames (seq>0) — they'd regress position to the corpse
    // spot and re-arm held keys.
    player.lastValidPosition = { ...spawn };
    player.lastValidVelocity = { x: 0, y: 0, z: 0 };
    player.lastValidRotation = { yaw: 0, pitch: 0 };
    player.hasReceivedPosition = false;
    player.lastPosCheckTime = wallMs(0);
    player.lastPosCheckPos = { ...spawn };
    player.consecutiveRejects = 0;
    // Rewind buffer: corpse-side samples must not survive the respawn —
    // hit validation and muzzle checks would rewind to the death site.
    player.history.length = 0;
    player.history.push({ t: wallNow(), x: spawn.x, y: spawn.y, z: spawn.z });
    player.protectedUntil = simMs(simNow() + SPAWN_PROTECT_MS);

    return { position: { ...player.position }, rotation: { ...player.rotation }, armorClass: player.armorClass };
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
}
