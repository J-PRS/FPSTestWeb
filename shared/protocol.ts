/**
 * Shared protocol - every message that crosses the wire, defined once.
 * Server imports these directly; client imports for typed handlers.
 *
 * Hot-path messages (position up, tickUpdate down) travel as binary frames
 * encoded by wire.ts - these types document the DECODED shapes, which the
 * codec produces/consumes.
 *
 * Bump PROTOCOL_VERSION whenever the wire format changes in a way that a
 * stale client can't safely ignore (new binary frame layout, removed
 * message, changed field semantics). The server stamps it on gameState;
 * the client force-reloads on mismatch instead of silently desyncing.
 */
import type { PickupKind } from './pickups.js';
import type { DeployKind } from './deployables.js';
import type { TeamId } from './teams.ts';
import type { AtmosphereSpec, SpawnPoint, StructureSpec, WaterSpec, WeatherSpec } from './mapSpec.ts';
import type { ResultToken } from './resultToken.ts';
export const PROTOCOL_VERSION = 15; // +intel IFF contacts - stale clients must not gate-free render

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Server↔client socket transports; client adds 'p2p'/'host' locally. */
export type TransportKind = 'wt' | 'rtc' | 'ws';

/** Creation-time room modifiers, defined once. The wire carries them as
 *  flat optional booleans on join/switchRoom/gameState (a stale client
 *  simply omits them); internally they travel as this one object through
 *  roomFor/quickRoom/SessionManager so a new modifier is one field, not
 *  a signature change in six files. igun implies gungame. */
export interface RoomMods {
  unlisted?: boolean;
  noCreatures?: boolean;
  noBalls?: boolean;
  instagib?: boolean;
  gungame?: boolean;
  igun?: boolean;
}

/** Collect the flat wire fields into the mods object the room layer
 *  consumes. Absent/false fields normalize to undefined so `mods.x`
 *  reads as a plain boolean check. */
export function roomModsOf(m: RoomMods | undefined | null): RoomMods {
  if (!m) {return {};}
  const out: RoomMods = {};
  if (m.unlisted) {out.unlisted = true;}
  if (m.noCreatures) {out.noCreatures = true;}
  if (m.noBalls) {out.noBalls = true;}
  if (m.instagib) {out.instagib = true;}
  if (m.gungame || m.igun) {out.gungame = true;}
  if (m.igun) {out.igun = true;}
  return out;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

/** One IFF contact on the intel message - id + last-known feet pos. */
export interface IntelContact {
  id: string;
  x: number;
  y: number;
  z: number;
}

export type ClientMessage =
  // room: optional match room - server validates [\w-]{1,32}, absent =
  // 'default'. mode: only honored when the join creates the room.
  | { type: 'join'; playerId: string; token?: string; room?: string; mode?: string; perk?: string; armorClass?: string;
      /** Equipped Q-slot skill - the server shadows its cooldown; a claim
       *  naming a different skill is refused. */
      skill?: string;
      /** Chosen display name - sanitized server-side, carried on
       *  gameState/playerJoined for scoreboard/chat/feed rendering. The
       *  id remains the identity; names are cosmetic and non-unique. */
      name?: string;
      /** map hint for room creation - /join-spawned rooms can be disposed
       *  and rebuilt before the first join lands, so the join carries the
       *  spec source too. bots overrides the spec's bot count. */
      map?: string; bots?: number;
      /** Creation-time flag: keep the room off /rooms and out of
       *  quick-join picks - in only by knowing the name. Honored only
       *  when this join creates the room (like `mode`). */
      unlisted?: boolean;
      /** Creation-time sim gates: strip creature (melee species) / ball
       *  populations from a fresh room - honored like `mode`, only when
       *  this join creates the room. */
      noCreatures?: boolean; noBalls?: boolean;
      /** Creation-time modifier: instagib rules - light class, railgun
       *  + hook only, 200dmg rail hits. Layers onto any mode like
       *  noBalls; honored only at room creation. */
      instagib?: boolean;
      /** Creation-time modifier: gun game ladder - every player fields
       *  the rung weapon, kills advance, deaths reset. igun is the same
       *  ladder with ~200-effective damage on every weapon. */
      gungame?: boolean; igun?: boolean;
      /** Netcode-v2 tier the client negotiated - /metrics tier counts. */
      transport?: string;
      /** Offset cursor: last reliable `ev` seq the client processed - a
       *  reclaim presents it so the server replays only the missed frames
       *  (Socket.IO connection-state-recovery shape). */
      resumeSeq?: number;
      /** Opt-in spawn hold: the seat's body stays out of the world until
       *  'ready' - browser clients declare it (their session veil covers
       *  the warmup); bots/probes omit it and spawn at seat like always.
       *  Stickiness: the flag lives on the player record so a reclaim
       *  re-holds the body the same way. */
      spawnHold?: boolean }
  // input rides every volatile frame as held state - a superseding
  // stream where loss costs nothing (the next frame carries the same
  // state). On unordered lanes the position seq gates staleness.
  | { type: 'position'; position: Vec3; rotation: Rotation; velocity: Vec3; seq?: number; inputSeq?: number; ping?: number;
      input?: { forward: number; right: number; jump: number; ski: number; jet?: number } }
  // Declared discontinuity (warp beacon, respawn): the position is
  // authoritative, not a plausibility-checked move - the server reseats
  // its check anchor here instead of rejecting it as a speedhack.
  | { type: 'teleport'; position: Vec3; rotation: Rotation; velocity: Vec3 }
  | { type: 'ping'; timestamp: number }
  // Echo of a server-issued ping - the unforgeable RTT channel: the
  // server measures round-trip itself instead of trusting the
  // client-reported ping riding every position frame.
  | { type: 'pong'; timestamp: number }
  // Client-side ops telemetry the server can't see itself - self-reported
  // fps/frame cost and link quality, ~10s cadence, rolled into /metrics so
  // a client's bad connection or melting renderer surfaces server-side.
  | { type: 'clientStats'; fps: number; jsMs: number; ping: number; loss: number; jitter: number; renderLagMs?: number; renderLag?: Record<string, number>; gap?: number; starve?: number; starveMs?: number; drainMsMax?: number }
  | { type: 'chat'; text: string; team?: boolean; vgs?: string }
  // shotId is a client-generated nonce stamped at spawn and echoed on
  // every claim naming this shell - binding is explicit identity, not
  // the echo-race/FIFO inference it replaced.
  | { type: 'aoeShot'; position: Vec3; weaponType?: number; excludeTargetId?: string | null; projectileId?: string | null; airtime?: number; power?: number; directHit?: boolean; shotId?: string; claimSeq?: number;
      // fireAt: the shooter's server-clock estimate of the trigger
      // instant - lets the server measure this claim's real uplink
      // transit instead of estimating it from the ping/pong EMA.
      fireAt?: number }
  // Q-skill Slam landing - the intent carries WHERE the dive landed;
  // the server derives blast power from its own velocity shadow (the
  // dive speed IS the payload - a claimed speed is just a number).
  | { type: 'slam'; position: Vec3; claimSeq?: number }
  // Hitscan fire (fan/beam kinds) has no projectile for observers to see -
  // this cosmetic "I pulled the trigger" lets the server relay a playerShot
  // so firefights are audible/visible. For server-simmed weapons
  // (SERVER_SIMMED_WEAPONS) it's the fire INTENT instead: the server
  // spawns an authoritative shell, echoes shotId on projectileCreated,
  // and declares all outcomes - pos/shotId only help binding, never truth.
  | { type: 'shotFired'; weaponType?: number; dir?: Vec3; pos?: Vec3; vel?: Vec3; shotId?: string; fireAt?: number }
  // tickNack: client lost a tick-frame burst - asks the room to run a
  // full-record window so masked-field baselines reseed in ~1s instead
  // of waiting out the staggered-full cadence. Payload-free: gap size is
  // diagnostic only and a forged nack just wastes a full window.
  | { type: 'tickNack' }
  | { type: 'jump'; position: Vec3 }
  | { type: 'jetpack'; position: Vec3 }
  // inputMove is a change-only stream - on unordered transports (RTC/WT
  // datagrams) events can land out of order, so each carries a seq and the
  // server drops stale ones.
  // prev piggybacks the previous edge - the classic "every packet sends a
  // copy of the last" redundancy (GGPO/X-Wing): a single lost packet then
  // costs nothing instead of a watchdog round-trip.
  | { type: 'inputMove'; seq?: number; ageMs?: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }; rotation: Rotation;
      prev?: { seq?: number; ageMs?: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }; rotation: Rotation } }
  | { type: 'projectileDestroy'; projectileId: string; shotId?: string; claimSeq?: number }
  // claimSeq stamps the claim kinds the client wants a verdict for -
  // every claim carrying one gets a claimAck back (applied vs rejected+
  // reason), so a rejected claim is never indistinguishable from a lost
  // packet. Absent = legacy fire-and-forget, no ack sent.
  // attacker: optional source tag (host-simmed bots 'bot:NAME', deployables)
  // so kill credit/feed names the real shooter instead of 'environment'.
  | { type: 'environmentDamage'; amount: number; attacker?: string; claimSeq?: number }
  // Client-claimed pickups (nuggets): self-only heal, server clamps the
  // amount so it can't be a cheat lever - it exists so server health stays
  // the truth instead of drifting under each nugget the client ate.
  | { type: 'heal'; amount: number; claimSeq?: number }
  // Hit claim on a server-owned creature (balls are server-authoritative
  // when connected). damage is clamped server-side; kx/ky/kz is the
  // normalized knockback direction the shot imparted (server scales it
  // by weapon force itself). See server_bun/src/BallSim.ts.
  | { type: 'creatureHit'; id: number; damage: number; kx?: number; ky?: number; kz?: number; claimSeq?: number }
  // Same claim, but on a melee-species crawler - separate channel because
  // the two id namespaces don't overlap (crawl ids live in CreatureSim).
  | { type: 'crawlerHit'; id: number; damage: number; kx?: number; ky?: number; kz?: number; claimSeq?: number }
  | { type: 'deploy'; kind: DeployKind; position: Vec3; vel?: Vec3; claimSeq?: number }
  // Repair-tool beam tick: the server re-derives range, LOS, team and the
  // heal amount itself - the claim carries only WHICH deployable.
  | { type: 'repair'; targetId: number; claimSeq?: number }
  // One-shot skill activation (blink/dash/slam/warp/bounce): the client
  // already spent ENERGY.skillCost locally - this claim only mirrors the
  // ante into the server's shadow tank. Carries nothing else.
  | { type: 'skillUse'; claimSeq?: number; skill?: string }
  // Deliberate respawn (the K bind): a self-kill claim that funnels
  // through the normal death path - kill feed, respawn timer, corpse
  // charge - rather than a teleport shortcut, so a pending class/perk
  // banks exactly like any other death. `hold` arms the respawn hold:
  // the kill stays dead until a plain (dead-state) respawn arrives -
  // the L bind's die-and-spectate.
  | { type: 'respawn'; hold?: boolean }
  // Tribes flag toss - the carrier hurls the objective along their look
  // dir (teammate hand-off or ditching it away from a collapsing defense).
  | { type: 'throwFlag' }
  | { type: 'snapshotRequest' }
  // Spawn gate: the seat's body stays out of the world until the client
  // reports ready (session veil dropped = rendering stable). Join and
  // reclaim both hold; the server's READY_HOLD_MS timeout covers a
  // client that dies mid-veil.
  | { type: 'ready' }
  // Catch-up resync - ask for a fresh world-state replay (gameState +
  // rosters) without a room hop or reconnect, e.g. after an alt-tab
  // backlog. Server answers with the same payload as a (re)join.
  | { type: 'resync' }
  // Loadout class picked mid-match - stored as pending and applied on the
  // next respawn (Tribes rule: no instant tier swap mid-life, it'd be a
  // heal exploit and a desync lever).
  | { type: 'classUpdate'; armorClass: string }
  // Same rule for the passive pick - banked at respawn so mods (HP,
  // energy, speed) never flip mid-life under the server's nose.
  | { type: 'perkUpdate'; perk: string }
  // Held-weapon edge: the server's roster `weapon` is otherwise only
  // learned from fire intents, so a remote draws the stock prop until
  // the first shot. Cosmetic - no outcome adjudication reads it.
  | { type: 'held'; weapon: number }
  // Mid-match room hop over the live socket - the server re-seats the
  // session in the target room and answers with a fresh gameState, which
  // the client's existing reconnect path rebuilds from. Same creation
  // hints as join; room absent = 'default'.
  | { type: 'switchRoom'; room?: string; mode?: string; map?: string; bots?: number; unlisted?: boolean; noCreatures?: boolean; noBalls?: boolean; instagib?: boolean; gungame?: boolean; igun?: boolean };

export interface TickUpdatePlayer {
  playerId: string;
  internalId?: string; // not on the binary wire - roster field from gameState/playerJoined
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  ping?: number;
  ski?: number;
  /** Held jet input bit - remote dead-reckoning burns thrust on it. */
  jet?: number;
  /** Status bitmask - STATUS_* bits (shared/status.ts). */
  status?: number;
  /** Server-side sheep meter (0-100) - bots report theirs through the
   *  same field humans are metered under, so the leaderboard column
   *  fills for the whole roster. */
  sheep?: number;
}

export type ServerMessage =
  // room/mode: which match this state belongs to - set by the room's first
  // joiner, inherited by everyone after (join claims can't redefine it).
  | { type: 'gameState'; players: GameStatePlayer[]; localPlayerState?: LocalPlayerState; sessionToken?: string; protocolVersion?: number; room?: string; mode?: string; instagib?: boolean; gungame?: boolean; igun?: boolean; mapName?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; map?: { mode?: string; bases?: { alpha?: Vec3; bravo?: Vec3 }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; killY?: number; ambient?: Record<string, number>; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; water?: WaterSpec; spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] } }; flags?: { team: TeamId; pos: Vec3; home?: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; pickups?: { id: number; pos: Vec3; kind?: PickupKind; val?: number; vel?: Vec3 }[]; deployables?: { id: number; owner: string; kind: DeployKind; pos: Vec3; hp?: number; armor?: number; team?: string }[]; matchEndsAt?: number; respawnMs?: number; wireIds?: Record<number, string>; udp?: { token: string; port: number }; serverVersion?: string; serverBuild?: string | null }
  | { type: 'playerJoined'; playerId: string; internalId: string; position: Vec3; rotation: Rotation; team?: TeamId; transport?: string; armorClass?: string;
      /** Chosen display name (cosmetic - ids are still the identity). */
      name?: string;
      /** Current vitals - an announce can't fabricate 100/alive for a
       *  wounded or dead grace rejoiner (hash checks would flag the gap
       *  until the first tick record). Optional for old peers. */
      health?: number; isDead?: boolean;
      /** Server-known current weapon - remotes draw the real gun before
       *  the first shot edge. Bot loadouts announce it at join. */
      weapon?: number;
      /** Server-declared stale feed - a joiner who is already stale
       *  announces the ghost, not a fresh body. */
      stale?: boolean }
  | { type: 'playerLeft'; playerId: string }
  /** u16 wire-id roster for v3 tick frames - arrives on this reliable
   *  lane before any binary frame can reference the ids it adds. */
  | { type: 'wireIds'; add: Record<number, string>;
      /** Retired bindings - a departed player's id gets recycled after a
       *  quiet window; clients drop the stale entry so the recycled id
       *  can never resolve to the ghost. */remove?: number[] }
  // Team reassignment mid-match - team comes through playerJoined/gameState
  // otherwise; this is the only channel for a swap after join (bot rebalance).
  | { type: 'teamUpdate'; playerId: string; team: TeamId }
  // Headhunt held-token count changed (grab/death/reset) - rare event
  // channel so the tick frame keeps its fixed binary layout. n is the
  // carrier's new total; the team's live score is derived from these.
  | { type: 'playerHeld'; playerId: string; n: number }
  // Mid-life weapon swap - remotes swap the hand prop to the real
  // silhouette without waiting for a shot edge (spawn/roster rows
  // carry the same field for joiners).
  | { type: 'weaponUpdate'; playerId: string; weapon: number }
  // Server-declared feed staleness (position claims stopped while the
  // socket lives) - remotes render the body ghosted, still hittable.
  | { type: 'playerStale'; playerId: string; stale: boolean }
  // Server system line - renders unstyled (no "name:" prefix) in chat.
  // multi/actor/ann tag announced kills so the client's booth voice
  // can fire without parsing text - ann is a semantic key ('firstblood',
  // 'rampage', ...), the client maps it to a clip or TTS.
  | { type: 'matchNotice'; text: string; multi?: number; actor?: string; ann?: string }
  // seq lets a re-delivered event (reconnect replay, transport dup) be
  // dropped client-side - it's process-monotonic, never reused.
  | { type: 'playerHit'; shooterId: string; targetId: string; damage: number; health: number; armor?: number; seq?: number; shotId?: string;
      /** Ghost delta (m) - sent only when the credited rewind ghost sat
       *  >1.5m off live truth; the shooter sees the discrepancy live. */
      gd?: number }
  // Powerup grabbed - heal/armor/regen/dd buff applied to the collector.
  // `until` is server epoch ms for timed buffs; armor/health are absolute.
  | { type: 'buff'; kind: 'heal' | 'armor' | 'regen' | 'dd' | 'shield'; armor?: number; health?: number; until?: number }
  | { type: 'playerKill'; shooterId: string; targetId: string; weapon?: number;
      /** Shooter's consecutive-kill count after this frag - kill feed can
       *  render "🔥x5" without tracking streaks itself. */
      streak?: number;
      /** Projectile airtime (s) at the kill - feed shows `[1.3s]` so long
       *  lobs get credit. Absent for hitscan/melee/env kills. */
      air?: number;
      /** Lifesteal perk healed the shooter on this frag - clients render
       *  the red implode VFX on the killer. */
      steal?: boolean }
  // Gun-game ladder position, pushed to the owning client only - the
  // rung changes on kill/death edges, so a dedicated edge beats riding
  // the roster row. rung indexes shared/gunGame.GUN_GAME_LADDER.
  | { type: 'gunRung'; rung: number; wt?: number }
  | { type: 'knockback'; targetId: string; position: Vec3; force: number; pull?: boolean; yank?: boolean }
  | { type: 'playerRespawn'; playerId: string; internalId: string; position: Vec3; rotation: Rotation; armorClass?: string; health?: number }
  | { type: 'jump'; playerId: string; position: Vec3 }
  | { type: 'jetpack'; playerId: string; position: Vec3 }
  | { type: 'projectileCreated'; projectileId: string; ownerId: string; position: Vec3; velocity: Vec3; weaponType?: number; shotId?: string; pellet?: number; age?: number; t?: number }
  // Cosmetic relay of a hitscan trigger-pull: pos is server-stamped
  // (rewind to fire time), dir is the shooter's claimed aim - never
  // trusted for damage, only for muzzle audio/visual on observers.
  | { type: 'playerShot'; id: string; weaponType?: number; pos?: Vec3; dir?: Vec3 }
  | { type: 'projRide'; projectileId: string; host: string }
  | { type: 'projectileDestroyed'; projectileId: string; shotId?: string;
      /** Server-true contact point - replicas snap here before exploding
       *  so the predicted blast center IS the authority's. */
      position?: Vec3;
      /** Server shell's age at detonation - lets the parity ledger
       *  compare same-epoch positions instead of a ping estimate. */
      age?: number }
  | { type: 'snapshot'; players: SnapshotPlayer[]; timestamp: number }
  | { type: 'stateHash'; hash: string; tick: number; playerCount: number; timestamp: number;
      /** §4.7 replica lanes keyed by kind name - `hash` the client
       *  recomputes, optional per-id `fields` rows (declared field
       *  order) it diffs on a miss to name the diverging entry.
       *  Adding a fidelity lane is a key here, not new named slots. */
      replica?: Record<string, { hash: string; fields?: unknown[][] } | undefined> }
  | { type: 'tickUpdate'; updates: TickUpdatePlayer[]; ackSeq?: number }
  | { type: 'correction'; seq: number; position: Vec3; velocity: Vec3; rotation: Rotation;
      /** Last inputMove seq the server consumed - the client replays its
       *  input journal from here after rewinding to this state. */
      inputSeq?: number; grounded?: boolean }
  /** Hard-tolerance trip: the client's input watermark outran what the
   *  server consumed - re-emit current input. `lastSeq` is the server's
   *  consumed inputMove seq (the same value the tick frame's inputAck
   *  field confirms every tick). */
  | { type: 'inputSync'; lastSeq: number }
  /** Uniform claim verdict - one ack per claim that carried claimSeq.
   *  `reason` is the server's drop cause when ok=false. The client's
   *  pending-claim ledger classifies the rest (transport-lost,
   *  unconfirmed) instead of guessing. */
  | { type: 'claimAck'; kind: string; seq: number; ok: boolean; reason?: string }
  // Relayed declared-teleport - observers snap instead of interpolating
  // across the gap (interp across 50m reads as a rocket-flight glitch)
  | { type: 'teleport'; playerId: string; position: Vec3; velocity: Vec3 }
  // --- Server-simmed creatures (balls) -----------------------------------
  // Flight is closed-form between events (gravity + enrage accel are both
  // deterministic), so the wire carries only SEGMENT boundaries: every
  // velocity discontinuity. A client replays the same integrator and lands
  // on the same arc - no position stream at all.
  | { type: 'ballSpawn'; id: number; variant: number; colorIdx: number; position: Vec3; velocity: Vec3; targetId?: string | null; tp?: Vec3 | null; t: number }
  | { type: 'ballSegment'; id: number; position: Vec3; velocity: Vec3; enraged: boolean; targetId: string | null; kind: string; t: number; et?: number; slowT?: number; damp?: boolean; tp?: Vec3 | null }
  | { type: 'ballDie'; id: number; position: Vec3; by?: string | null }
  // Server-owned melee species (creatureSim.ts). Same idea as balls but
  // hop-driven: wander/chase/windup are RNG-seeded and deterministic, so
  // the wire carries only edge events (retarget windup pounce bite die)
  // - predictors replay the identical hop stream in between.
  | { type: 'crawlSpawn'; id: number; position: Vec3; seed: number; uber: boolean; species: string; targetId?: string | null; tp?: Vec3 | null; t: number }
  | { type: 'crawlEvt'; id: number; kind: 'retarget' | 'windup' | 'pounce' | 'bite' | 'detonate' | 'charge' | 'fire' | 'blink'; position: Vec3; velocity: Vec3; targetId: string | null; tp?: Vec3 | null; t: number;
      /** Cumulative retarget-skip count since spawn - a retarget tick is
       *  a sim step the creature never took; absolute so missed edges
       *  still converge the replay's step budget. */
      sk?: number;
      /** Live LCG state - a lost edge that consumed a crand draw desyncs
       *  the replica's cooldown stream permanently without it. */
      seed?: number }
  | { type: 'crawlDie'; id: number; position: Vec3; by?: string | null }
  | { type: 'crawlRoster'; crawlers: { id: number; position: Vec3; velocity: Vec3; uber: boolean; seed: number; species: string; state: string; targetId: string | null; tp?: Vec3 | null; t: number; sk?: number; ph?: number; od?: number }[] }
  // Roster for joiners/reconnects - current segment state of every live ball
  | { type: 'ballRoster'; balls: { id: number; variant: number; colorIdx: number; position: Vec3; velocity: Vec3; enraged: boolean; targetId: string | null; tp?: Vec3 | null; et?: number; slowT?: number; damp?: boolean; t: number }[] }
  // Server-issued RTT probe - the client echoes it back as 'pong'.
  | { type: 'ping'; timestamp: number }
  | { type: 'pong'; timestamp: number }
  // Server-measured RTT echoed to the probed player - the scoreboard's
  // client/server ping pair; the client number counts its own event-loop
  // stall, this one doesn't.
  | { type: 'srvPing'; rtt: number }
  | { type: 'chat'; playerId: string; text: string; team?: boolean; vgs?: string; muted?: boolean }
  // --- Match scoreboard (team-mode rooms) --------------------------------
  | { type: 'flagUpdate'; flags: { team: TeamId; pos: Vec3; home?: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[] }
  // Conquest lattice - the whole node set (≤25 rows) on every edge; the
  // mode's lifecycle is one roster feed, no spawn/gone verbs.
  | { type: 'nodeUpdate'; nodes: { id: number; gx: number; gz: number; pos: Vec3; owner: 'alpha' | 'bravo' | 'neutral'; hp: number; maxHp: number; build: number; buildBy: 'alpha' | 'bravo' | null; core: boolean }[] }
  // Server-owned pickups: creature kills drop a nugget gem; touching it
  // banks a team point - replaces trusting client 'bank' claims.
  | { type: 'pickupSpawn'; id: number; pos: Vec3; kind?: PickupKind; val?: number; vel?: Vec3 }
  | { type: 'deploySpawn'; id: number; owner: string; kind: DeployKind; pos: Vec3; team?: TeamId }
  | { type: 'deployGone'; id: number }
  // Base-asset lifecycle - authored gear goes DOWN (not gone) on death
  // and back UP on respawn/repair; clients paint wreck→live transitions.
  | { type: 'deployDown'; id: number; kind: DeployKind; team?: string; respawnS: number }
  | { type: 'deployUp'; id: number }
  // Durability sync - hp + overcharge armor riding whenever either moves.
  | { type: 'deployHp'; id: number; hp: number; armor: number; src?: string }
  // Base sensor sweep - hostiles inside the mast's radius, relayed to
  // the owning team as map pings. Not hit feedback - pure intel.
  | { type: 'sensorPing'; id: number; team?: string; targets: { id: string; x: number; y: number; z: number }[] }
  // Server-truth IFF: which hostiles THIS client may mark, full stop.
  // `seen` = detected in the latest sweep (marker rides the live body);
  // `mem` = lingering contacts at their last-known position (recon perk
  // stretches only the viewer's own memory - never the team's). Every
  // expiry is stamped server-side; a client cannot fabricate a contact.
  | { type: 'intel'; seen: IntelContact[]; mem: IntelContact[] }
  // Server-owned sentry fired at a player - clients render the rocket
  // visual; damage itself arrives through playerHit like everything else.
  | { type: 'turretShot'; id: number; owner: string; targetId: string }
  // Base sentry bolt - unlike turretShot the blast lands at the aim point,
  // not on the target: the client paints a straight-line shell to x/y/z.
  | { type: 'sentryShot'; id: number; owner: string; x: number; y: number; z: number }
  // Mortar turret launch - the arc is carried as solved velocity; clients
  // spawn a replica shell on the identical ballistic path.
  | { type: 'mortarShot'; id: number; owner: string; vx: number; vy: number; vz: number }
  // Server-owned mine tripped - clients paint the blast FX; damage itself
  // arrives through playerHit/knockback like everything else.
  | { type: 'mineBoom'; id: number; owner: string; pos: Vec3 }
  // Jump pad discharged - launch FX only; the body's new velocity
  // arrives through the normal sim channel. nx/ny/nz = launch dir.
  | { type: 'padBoing'; id: number; pos: Vec3; nx: number; ny: number; nz: number }
  | { type: 'loiterDive'; id: number; pos: Vec3; vx: number; vy: number; vz: number }
  // Hard landing measured on the movement shadow - the owner already
  // played their predicted thud/dust; this is for everyone else in
  // earshot (remote bodies get no landing edges otherwise).
  | { type: 'landed'; playerId: string; pos: Vec3; impact: number }
  | { type: 'pickupGone'; id: number; by: string | null }
  // Server-owned heals (regen perk, mend channel, regen powerup) mutate
  // health silently every tick - self is excluded from tickUpdate, so
  // without this echo the owner's hp drifts until the next hit event.
  | { type: 'yourHealth'; health: number; armor?: number }
  // Your own banked LG charge - own tick records exclude the carrier, so
  // the server echoes it directly while >0 (and once more at 0).
  | { type: 'yourCharge'; charge: number }
  // Server-authoritative pool ammo (ammoCap weapons) - [weaponType, rounds]
  // pairs. The client predicts spends, so the echo only runs while some
  // pool sits below cap: rejects/regen drift snap back to truth.
  | { type: 'yourAmmo'; ammo: [number, number][] }
  // Combat claim refused - the shooter's predicted damage never happened.
  // Sent ONLY to the shooter so the client can log why a landed shot did
  // nothing (stale projectile, dead/friendly target, implausible claim).
  | { type: 'shotRejected'; reason: string; targetId?: string; weaponType?: number;
      /** Server-authoritative health - a rejected claim may have applied
       *  predicted self-splash locally, so this lets the client resync
       *  instead of running divergent health until the next real hit. */
      health?: number;
      /** The claim's own nonce - a client that retransmits un-acked spawns
       *  must stop on a reject (it's a verdict, not transport loss), and
       *  without the id it can't tell the two apart. */
      shotId?: string }
  // Claim dropped without judgement - dead shooter/target mid-flight, an
  // honest-lag discard that must still clear the shooter's predicted-hit
  // ledger. Kept distinct from shotRejected so reject tallies stay pure.
  | { type: 'claimDropped'; reason: string; targetId?: string; weaponType?: number;
      health?: number;
      /** Same role as on shotRejected - lets a resending client drop the
       *  dead claim instead of re-firing it. */
      shotId?: string }
  // Anti-cheat verdict surfaced to the flagged player instead of a kick -
  // renders on the conn-banner slot so it reads as a warning, not chat.
  | { type: 'serverWarn'; text: string }
  // Close-code 1008 doesn't propagate over the WT/RTC tiers - identity
  // rejections (claimed id, bad token) also send this so the client can
  // drop its stored session instead of rejoin-looping on a stale token.
  | { type: 'sessionRejected'; reason: string }
  | { type: 'teamScore'; scores: { alpha: number; bravo: number }; winAt: number }
  // scores = full-board echo (legacy/join path); playerId+score = single-row
  // delta (the steady-state path - a full map per kill was the chatty-JSON
  // egress the stress run surfaced). rm = drop that player's row.
  | { type: 'ffaScore'; scores?: Record<string, number>; playerId?: string; score?: number; rm?: boolean; winAt: number }
  | { type: 'ffaMatchEnd'; winner: string; scores: Record<string, number> }
  | { type: 'matchEnd'; winner: TeamId | 'draw'; scores: { alpha: number; bravo: number } }
  | { type: 'matchStart'; mode: string; scores: { alpha: number; bravo: number } }
  // Signed match receipt - leaderboard submissions pair the player's demo
  // with this token; sig is null when the server runs without a key.
  | { type: 'matchToken'; token: ResultToken }
  // Admin hot-reload: the room's map spec changed - clients rebuild
  // structures/dome from this instead of re-joining for a gameState.
  | { type: 'mapUpdate'; mapName?: string; silent?: boolean; bases?: { alpha?: Vec3; bravo?: Vec3 }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; killY?: number; ambient?: Record<string, number>; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; water?: WaterSpec; spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] }; terrainTex?: string; terrainPreset?: number; sky?: string; weather?: WeatherSpec; atmosphere?: AtmosphereSpec; interiors?: { file: string; pos: Vec3; rot?: number[]; scale?: Vec3 }[] };

export interface GameStatePlayer {
  id: string;
  /** Chosen display name - cosmetic, non-unique; ids stay the identity. */
  name?: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  isDead: boolean;
  health: number;
  status?: number;
  /** Headhunt held-token count - rides the roster row for joiners; live
   *  changes arrive via the playerHeld event. */
  held?: number;
  /** Team-mode rooms only - absent in free-for-all. */
  team?: TeamId;
  /** Netcode-v2 tier this client connected on - scoreboard NET column.
   *  'ws+udp' composite when a udp volatile lane is live. */
  transport?: string;
  /** Armor tier - remote model renders bulkier (heavy) or slimmer (light). */
  armorClass?: string;
  /** Server-known current weapon (bot loadout / last simmed shell) -
   *  remotes draw a real gun, not the placeholder. */
  weapon?: number;
  /** Server-declared stale feed - remotes ghost the body, never hide it. */
  stale?: boolean;
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
  /** Shadow's consumed inputMove watermark - lets a reconnecting client
   *  replay journaled inputs over the restored anchor instead of
   *  hard-snapping to a seconds-stale position (lossy-link flap). */
  inputSeq?: number;
  /** Spawn shield remaining - the client suppresses the same predicted
   *  blast effects the server refuses to apply during the window. */
  protectedMs?: number;
  /** Headhunt held tokens - survives the reconnect so the HUD counter
   *  doesn't zero until the first playerHeld edge. */
  held?: number;
  /** Server's bloom-cone draw counter - the client predicts the same
   *  seeded jitter per pull, so a re-seat (reclaim carried the seq, or
   *  demote reset it to 0) must adopt the authority's count or every
   *  jittered shot diverges for the rest of the session. */
  bloomSeq?: number;
}
