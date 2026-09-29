/**
 * Shared protocol — every message that crosses the wire, defined once.
 * Server imports these directly; client imports for typed handlers.
 *
 * Hot-path messages (position up, tickUpdate down) travel as binary frames
 * encoded by wire.ts — these types document the DECODED shapes, which the
 * codec produces/consumes.
 *
 * Bump PROTOCOL_VERSION whenever the wire format changes in a way that a
 * stale client can't safely ignore (new binary frame layout, removed
 * message, changed field semantics). The server stamps it on gameState;
 * the client force-reloads on mismatch instead of silently desyncing.
 */
import type { PickupKind } from './pickups.js';
export const PROTOCOL_VERSION = 11; // powerup pickup kinds + buff msg — stale clients' pickup tables would miss them

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

export type ClientMessage =
  // room: optional match room — server validates [\w-]{1,32}, absent =
  // 'default'. mode: only honored when the join creates the room.
  | { type: 'join'; playerId: string; token?: string; room?: string; mode?: string; perk?: string; armorClass?: string;
      /** map hint for room creation — /join-spawned rooms can be disposed
       *  and rebuilt before the first join lands, so the join carries the
       *  spec source too. bots overrides the spec's bot count. */
      map?: string; bots?: number;
      /** Netcode-v2 tier the client negotiated — /metrics tier counts. */
      transport?: string }
  | { type: 'position'; position: Vec3; rotation: Rotation; velocity: Vec3; seq?: number; inputSeq?: number; ping?: number }
  // Declared discontinuity (warp beacon, respawn): the position is
  // authoritative, not a plausibility-checked move — the server reseats
  // its check anchor here instead of rejecting it as a speedhack.
  | { type: 'teleport'; position: Vec3; rotation: Rotation; velocity: Vec3 }
  | { type: 'ping'; timestamp: number }
  | { type: 'chat'; text: string }
  | { type: 'shot'; targetId: string | null; weaponType?: number; position?: Vec3; velocity?: Vec3; timestamp?: number; projectileId?: string | null; airtime?: number }
  | { type: 'aoeShot'; position: Vec3; weaponType?: number; excludeTargetId?: string | null; projectileId?: string | null; airtime?: number; power?: number; directHit?: boolean }
  // Hitscan fire (fan/beam kinds) has no projectile for observers to see —
  // this cosmetic "I pulled the trigger" lets the server relay a playerShot
  // so firefights are audible/visible. Carries no damage semantics.
  | { type: 'shotFired'; weaponType?: number; dir?: Vec3 }
  | { type: 'jump'; position: Vec3 }
  | { type: 'jetpack'; position: Vec3 }
  // inputMove is a change-only stream — on unordered transports (RTC/WT
  // datagrams) events can land out of order, so each carries a seq and the
  // server drops stale ones.
  | { type: 'inputMove'; seq?: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }; rotation: Rotation }
  | { type: 'projectileDestroy'; projectileId: string }
  | { type: 'environmentDamage'; amount: number }
  // Client-claimed pickups (nuggets): self-only heal, server clamps the
  // amount so it can't be a cheat lever — it exists so server health stays
  // the truth instead of drifting under each nugget the client ate.
  | { type: 'heal'; amount: number }
  // Hit claim on a server-owned creature (balls are server-authoritative
  // when connected). damage is clamped server-side; kx/ky/kz is the
  // normalized knockback direction the shot imparted (server scales it
  // by weapon force itself). See server_bun/src/BallSim.ts.
  | { type: 'creatureHit'; id: number; damage: number; kx?: number; ky?: number; kz?: number }
  // Same claim, but on a melee-species crawler — separate channel because
  // the two id namespaces don't overlap (crawl ids live in CreatureSim).
  | { type: 'crawlerHit'; id: number; damage: number; kx?: number; ky?: number; kz?: number }
  | { type: 'deploy'; kind: 'turret' | 'mine' | 'station' | 'drone'; position: Vec3 }
  | { type: 'snapshotRequest' }
  // Loadout class picked mid-match — stored as pending and applied on the
  // next respawn (Tribes rule: no instant tier swap mid-life, it'd be a
  // heal exploit and a desync lever).
  | { type: 'classUpdate'; armorClass: string }
  // Same rule for the passive pick — banked at respawn so mods (HP,
  // energy, speed) never flip mid-life under the server's nose.
  | { type: 'perkUpdate'; perk: string }
  // Mid-match room hop over the live socket — the server re-seats the
  // session in the target room and answers with a fresh gameState, which
  // the client's existing reconnect path rebuilds from. Same creation
  // hints as join; room absent = 'default'.
  | { type: 'switchRoom'; room?: string; mode?: string; map?: string; bots?: number };

export interface TickUpdatePlayer {
  playerId: string;
  internalId?: string; // not on the binary wire — roster field from gameState/playerJoined
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  ping?: number;
  ski?: number;
  /** Status bitmask — STATUS_* bits (shared/status.ts). */
  status?: number;
}

export type ServerMessage =
  // room/mode: which match this state belongs to — set by the room's first
  // joiner, inherited by everyone after (join claims can't redefine it).
  | { type: 'gameState'; players: GameStatePlayer[]; localPlayerState?: LocalPlayerState; sessionToken?: string; protocolVersion?: number; room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; map?: { mode?: string; bases?: { alpha?: Vec3; bravo?: Vec3 }; structures?: { kind: 'box' | 'wall' | 'pillar' | 'ramp'; pos: Vec3; size: Vec3; rotY?: number; team?: 'alpha' | 'bravo' }[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number> }; flags?: { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; pickups?: { id: number; pos: Vec3; kind?: PickupKind }[]; deployables?: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: Vec3 }[]; matchEndsAt?: number; respawnMs?: number }
  | { type: 'playerJoined'; playerId: string; internalId: string; position: Vec3; rotation: Rotation; team?: 'alpha' | 'bravo'; transport?: 'wt' | 'rtc' | 'ws'; armorClass?: string }
  | { type: 'playerLeft'; playerId: string }
  // Team reassignment mid-match — team comes through playerJoined/gameState
  // otherwise; this is the only channel for a swap after join (bot rebalance).
  | { type: 'teamUpdate'; playerId: string; team: 'alpha' | 'bravo' }
  // Server system line — renders unstyled (no "name:" prefix) in chat.
  | { type: 'matchNotice'; text: string }
  | { type: 'playerHit'; shooterId: string; targetId: string; damage: number; health: number; armor?: number }
  // Powerup grabbed — heal/armor/regen/dd buff applied to the collector.
  // `until` is server epoch ms for timed buffs; armor/health are absolute.
  | { type: 'buff'; kind: 'heal' | 'armor' | 'regen' | 'dd'; armor?: number; health?: number; until?: number }
  | { type: 'playerKill'; shooterId: string; targetId: string; weapon?: number;
      /** Shooter's consecutive-kill count after this frag — kill feed can
       *  render "🔥x5" without tracking streaks itself. */
      streak?: number }
  | { type: 'knockback'; targetId: string; position: Vec3; force: number; pull?: boolean }
  | { type: 'playerRespawn'; playerId: string; internalId: string; position: Vec3; rotation: Rotation; armorClass?: string }
  | { type: 'jump'; playerId: string; position: Vec3 }
  | { type: 'jetpack'; playerId: string; position: Vec3 }
  | { type: 'projectileCreated'; projectileId: string; ownerId: string; position: Vec3; velocity: Vec3; weaponType?: number }
  // Cosmetic relay of a hitscan trigger-pull: pos is server-stamped
  // (rewind to fire time), dir is the shooter's claimed aim — never
  // trusted for damage, only for muzzle audio/visual on observers.
  | { type: 'playerShot'; id: string; weaponType?: number; pos?: Vec3; dir?: Vec3 }
  | { type: 'projectileDestroyed'; projectileId: string }
  | { type: 'snapshot'; players: SnapshotPlayer[]; timestamp: number }
  | { type: 'stateHash'; hash: string; tick: number; playerCount: number; timestamp: number }
  | { type: 'tickUpdate'; updates: TickUpdatePlayer[]; ackSeq?: number }
  | { type: 'correction'; seq: number; position: Vec3; velocity: Vec3; rotation: Rotation;
      /** Last inputMove seq the server consumed — the client replays its
       *  input journal from here after rewinding to this state. */
      inputSeq?: number; grounded?: boolean }
  // Relayed declared-teleport — observers snap instead of interpolating
  // across the gap (interp across 50m reads as a rocket-flight glitch)
  | { type: 'teleport'; playerId: string; position: Vec3; velocity: Vec3 }
  // --- Server-simmed creatures (balls) -----------------------------------
  // Flight is closed-form between events (gravity + enrage accel are both
  // deterministic), so the wire carries only SEGMENT boundaries: every
  // velocity discontinuity. A client replays the same integrator and lands
  // on the same arc — no position stream at all.
  | { type: 'ballSpawn'; id: number; variant: number; colorIdx: number; position: Vec3; velocity: Vec3; targetId?: string | null; tp?: Vec3 | null; t: number }
  | { type: 'ballSegment'; id: number; position: Vec3; velocity: Vec3; enraged: boolean; targetId: string | null; kind: string; t: number; et?: number; slowT?: number; damp?: boolean; tp?: Vec3 | null }
  | { type: 'ballDie'; id: number; position: Vec3; by?: string | null }
  // Server-owned melee species (creatureSim.ts). Same idea as balls but
  // hop-driven: wander/chase/windup are RNG-seeded and deterministic, so
  // the wire carries only edge events (retarget windup pounce bite die)
  // — predictors replay the identical hop stream in between.
  | { type: 'crawlSpawn'; id: number; position: Vec3; seed: number; uber: boolean; targetId?: string | null; tp?: Vec3 | null; t: number }
  | { type: 'crawlEvt'; id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite'; position: Vec3; velocity: Vec3; targetId: string | null; tp?: Vec3 | null; t: number }
  | { type: 'crawlDie'; id: number; position: Vec3; by?: string | null }
  | { type: 'crawlRoster'; crawlers: { id: number; position: Vec3; velocity: Vec3; uber: boolean; seed: number; state: string; targetId: string | null; tp?: Vec3 | null; t: number }[] }
  // Roster for joiners/reconnects — current segment state of every live ball
  | { type: 'ballRoster'; balls: { id: number; variant: number; colorIdx: number; position: Vec3; velocity: Vec3; enraged: boolean; targetId: string | null; tp?: Vec3 | null; t: number }[] }
  | { type: 'pong'; timestamp: number }
  | { type: 'chat'; playerId: string; text: string }
  // --- Match scoreboard (team-mode rooms) --------------------------------
  | { type: 'flagUpdate'; flags: { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[] }
  // Server-owned pickups: creature kills drop a nugget gem; touching it
  // banks a team point — replaces trusting client 'bank' claims.
  | { type: 'pickupSpawn'; id: number; pos: Vec3; kind?: PickupKind }
  | { type: 'deploySpawn'; id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: Vec3; team?: 'alpha' | 'bravo' }
  | { type: 'deployGone'; id: number }
  // Server-owned sentry fired at a player — clients render the rocket
  // visual; damage itself arrives through playerHit like everything else.
  | { type: 'turretShot'; id: number; owner: string; targetId: string }
  // Server-owned mine tripped — clients paint the blast FX; damage itself
  // arrives through playerHit/knockback like everything else.
  | { type: 'mineBoom'; id: number; owner: string; pos: Vec3 }
  | { type: 'pickupGone'; id: number; by: string | null }
  // Combat claim refused — the shooter's predicted damage never happened.
  // Sent ONLY to the shooter so the client can log why a landed shot did
  // nothing (stale projectile, dead/friendly target, implausible claim).
  | { type: 'shotRejected'; reason: string; targetId?: string; weaponType?: number;
      /** Server-authoritative health — a rejected claim may have applied
       *  predicted self-splash locally, so this lets the client resync
       *  instead of running divergent health until the next real hit. */
      health?: number }
  | { type: 'teamScore'; scores: { alpha: number; bravo: number }; winAt: number }
  | { type: 'ffaScore'; scores: Record<string, number>; winAt: number }
  | { type: 'ffaMatchEnd'; winner: string; scores: Record<string, number> }
  | { type: 'matchEnd'; winner: 'alpha' | 'bravo' | 'draw'; scores: { alpha: number; bravo: number } }
  | { type: 'matchStart'; mode: string; scores: { alpha: number; bravo: number } }
  // Admin hot-reload: the room's map spec changed — clients rebuild
  // structures/dome from this instead of re-joining for a gameState.
  | { type: 'mapUpdate'; bases?: { alpha?: Vec3; bravo?: Vec3 }; structures?: { kind: 'box' | 'wall' | 'pillar' | 'ramp'; pos: Vec3; size: Vec3; rotY?: number; team?: 'alpha' | 'bravo' }[]; arena?: { x: number; z: number; radius: number } | null; ambient?: Record<string, number>; terrain?: string };

export interface GameStatePlayer {
  id: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  isDead: boolean;
  health: number;
  status?: number;
  /** Team-mode rooms only — absent in free-for-all. */
  team?: 'alpha' | 'bravo';
  /** Netcode-v2 tier this client connected on — scoreboard NET column. */
  transport?: 'wt' | 'rtc' | 'ws';
  /** Armor tier — remote model renders bulkier (heavy) or slimmer (light). */
  armorClass?: string;
}

export interface SnapshotPlayer {
  id: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  kills: number;
  deaths: number;
}

export interface LocalPlayerState {
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  armor?: number;
}
