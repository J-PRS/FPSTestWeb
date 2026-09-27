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
export const PROTOCOL_VERSION = 3;

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
  | { type: 'join'; playerId: string; token?: string; room?: string; mode?: string }
  | { type: 'position'; position: Vec3; rotation: Rotation; velocity: Vec3; seq?: number; ping?: number }
  // Declared discontinuity (warp beacon, respawn): the position is
  // authoritative, not a plausibility-checked move — the server reseats
  // its check anchor here instead of rejecting it as a speedhack.
  | { type: 'teleport'; position: Vec3; rotation: Rotation; velocity: Vec3 }
  | { type: 'ping'; timestamp: number }
  | { type: 'chat'; text: string }
  | { type: 'shot'; targetId: string | null; weaponType?: number; position?: Vec3; velocity?: Vec3; timestamp?: number; projectileId?: string | null; airtime?: number }
  | { type: 'aoeShot'; position: Vec3; weaponType?: number; excludeTargetId?: string | null; projectileId?: string | null; airtime?: number; power?: number; directHit?: boolean }
  | { type: 'jump'; position: Vec3 }
  | { type: 'jetpack'; position: Vec3 }
  | { type: 'inputMove'; input: { forward: number; right: number; jump: number; ski: number }; rotation: Rotation }
  | { type: 'projectileDestroy'; projectileId: string }
  | { type: 'environmentDamage'; amount: number }
  // Client-claimed pickups (nuggets): self-only heal, server clamps the
  // amount so it can't be a cheat lever — it exists so server health stays
  // the truth instead of drifting under each nugget the client ate.
  | { type: 'heal'; amount: number }
  // Nugget banking claim — the client says "my team just banked n"
  // (pickups are client-detected); server clamps n so it's not a cheat
  // lever, then owns the score. Only meaningful in team-mode rooms.
  | { type: 'bank'; n: number }
  // Hit claim on a server-owned creature (balls are server-authoritative
  // when connected). damage is clamped server-side; kx/ky/kz is the
  // normalized knockback direction the shot imparted (server scales it
  // by weapon force itself). See server_bun/src/BallSim.ts.
  | { type: 'creatureHit'; id: number; damage: number; kx?: number; ky?: number; kz?: number }
  | { type: 'snapshotRequest' };

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
}

export type ServerMessage =
  // room/mode: which match this state belongs to — set by the room's first
  // joiner, inherited by everyone after (join claims can't redefine it).
  | { type: 'gameState'; players: GameStatePlayer[]; localPlayerState?: LocalPlayerState; sessionToken?: string; protocolVersion?: number; room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; map?: { mode?: string; bases?: { alpha?: Vec3; bravo?: Vec3 } }; flags?: { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; pickups?: { id: number; pos: Vec3 }[]; matchEndsAt?: number }
  | { type: 'playerJoined'; playerId: string; internalId: string; position: Vec3; rotation: Rotation; team?: 'alpha' | 'bravo' }
  | { type: 'playerLeft'; playerId: string }
  // Team reassignment mid-match — team comes through playerJoined/gameState
  // otherwise; this is the only channel for a swap after join (bot rebalance).
  | { type: 'teamUpdate'; playerId: string; team: 'alpha' | 'bravo' }
  // Server system line — renders unstyled (no "name:" prefix) in chat.
  | { type: 'matchNotice'; text: string }
  | { type: 'playerHit'; shooterId: string; targetId: string; damage: number; health: number }
  | { type: 'playerKill'; shooterId: string; targetId: string }
  | { type: 'knockback'; targetId: string; position: Vec3; force: number; pull?: boolean }
  | { type: 'playerRespawn'; playerId: string; internalId: string; position: Vec3; rotation: Rotation }
  | { type: 'jump'; playerId: string; position: Vec3 }
  | { type: 'jetpack'; playerId: string; position: Vec3 }
  | { type: 'projectileCreated'; projectileId: string; ownerId: string; position: Vec3; velocity: Vec3; weaponType?: number }
  | { type: 'projectileDestroyed'; projectileId: string }
  | { type: 'snapshot'; players: SnapshotPlayer[]; timestamp: number }
  | { type: 'stateHash'; hash: string; tick: number; playerCount: number; timestamp: number }
  | { type: 'tickUpdate'; updates: TickUpdatePlayer[]; ackSeq?: number }
  | { type: 'correction'; seq: number; position: Vec3; velocity: Vec3; rotation: Rotation }
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
  // Roster for joiners/reconnects — current segment state of every live ball
  | { type: 'ballRoster'; balls: { id: number; variant: number; colorIdx: number; position: Vec3; velocity: Vec3; enraged: boolean; targetId: string | null; tp?: Vec3 | null; t: number }[] }
  | { type: 'pong'; timestamp: number }
  | { type: 'chat'; playerId: string; text: string }
  // --- Match scoreboard (team-mode rooms) --------------------------------
  | { type: 'flagUpdate'; flags: { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[] }
  // Server-owned pickups: creature kills drop a nugget gem; touching it
  // banks a team point — replaces trusting client 'bank' claims.
  | { type: 'pickupSpawn'; id: number; pos: Vec3 }
  | { type: 'pickupGone'; id: number; by: string | null }
  | { type: 'teamScore'; scores: { alpha: number; bravo: number }; winAt: number }
  | { type: 'ffaScore'; scores: Record<string, number>; winAt: number }
  | { type: 'ffaMatchEnd'; winner: string; scores: Record<string, number> }
  | { type: 'matchEnd'; winner: 'alpha' | 'bravo' | 'draw'; scores: { alpha: number; bravo: number } }
  | { type: 'matchStart'; mode: string; scores: { alpha: number; bravo: number } };

export interface GameStatePlayer {
  id: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  isDead: boolean;
  health: number;
  /** Team-mode rooms only — absent in free-for-all. */
  team?: 'alpha' | 'bravo';
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
}
