// One world model - the C5 backbone. Every interactive entity kind
// declares itself ONCE here: which fields ride which sync channel
// (sim/edge/echo - same taxonomy as FIELD_CHANNELS) and which wire verbs
// carry its lifecycle. The spawn/gone/hash/diff surfaces are DERIVED
// from this declaration instead of hand-maintained in five places, so
// adding a field or a kind can't drift one lane out of sync with the
// rest - the Nth-copy-of-the-same-drift-bug class.
//
// Migration is incremental: a kind joins the table when its declaration
// is complete, and each consumer (hash diff, snapshot emit, spawn
// payload) moves onto the generated surface one at a time. 'ball' is
// the pilot - its edges and hash inputs already exist, so only the
// declaration is new.

import type { SyncChannel } from './stateHash.ts';
import { sharedNow } from './env.ts';
// the signal survives without the flood.
const warnOnceSeen = new Map<string, number>();

export interface KindFieldDecl {
  /** Field name on the sim's entity record (server) and the client replica. */
  name: string;
  /** Wire type - lets inbound checks verify SHAPE, not just presence: a
   *  string where a vec3 belongs poisons a replica as silently as a
   *  missing field. 'vec3' = {x,y,z} finite numbers; 'rot' = {yaw,pitch}; 'arr' = any array; 'obj' = any non-null object. */
  wire: 'num' | 'str' | 'bool' | 'vec3' | 'rot' | 'arr' | 'obj';
  channel: SyncChannel;
  /** Value emitted when the field is absent - the wire's sentinel for
   *  'not set' (deploy teams diff '' server-side, never null). */
  absent?: unknown;
}

export interface WorldKindDecl {
  /** Wire verb prefix: ball => ballSpawn / ballSegment / ballDie. */
  kind: string;
  verbs: { spawn?: string; update?: string; gone?: string; roster?: string };
  /** Lifecycle/mirrored fields a replica MUST agree on - hashed + diffed. */
  fields: KindFieldDecl[];
  /** Spawn payload shape - the full field list a spawn message carries,
   *  in wire order. Declared so the emit can't add a field the client's
   *  spawn handler doesn't consume. */
  spawnFields?: KindFieldDecl[];
  /** Gone payload shape - fields past the id a destroy message carries. */
  goneFields?: KindFieldDecl[];
  /** Update payload shape - fields past the id an update message carries
   *  (only for kinds whose update rides a JSON verb; binary updaters like
   *  ballSegment encode their own frame). */
  updateFields?: KindFieldDecl[];
  /** Roster row shape - the field list a join-time roster row carries.
   *  Spawn ⊄ roster: the roster adds live sim state (enraged, sim state)
   *  the spawn already derived. */
  rosterFields?: KindFieldDecl[];
  /** One-off lifecycle notifies that aren't spawn/update/gone - keyed by
   *  wire type (deployDown, deployUp). Same declared-shape contract:
   *  the emit and the inbound check both read this list. */
  events?: Record<string, KindFieldDecl[]>;
  /** Message-level fields of the roster envelope itself (gameState's
   *  room/mode/scores/map/... - the roster sweep covers ROWS, this
   *  covers the container's own payload). */
  envelope?: KindFieldDecl[];
  /** Message-level fields of the UPDATE envelope (tickUpdate's
   *  ackSeq/inputAck/tickSeq/count wrap the per-player rows). */
  updateEnvelope?: KindFieldDecl[];
}

export const WORLD_MODEL: Record<string, WorldKindDecl> = {
  ball: {
    kind: 'ball',
    verbs: { spawn: 'ballSpawn', update: 'ballSegment', gone: 'ballDie', roster: 'ballRoster' },
    fields: [
      { name: 'variant', wire: 'num', channel: 'edge' },
      { name: 'enraged', wire: 'bool', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'variant', wire: 'num', channel: 'edge' },
      { name: 'colorIdx', wire: 'num', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
    ],
    goneFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'by', wire: 'str', channel: 'edge' },
    ],
    // ballSegment rides a packed binary frame (wire.ts), not JSON - the
    // list still declares the shape once so the conformance test pins it.
    updateFields: [
      { name: 'kind', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'enraged', wire: 'bool', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      { name: 'et', wire: 'num', channel: 'edge' },
      { name: 'slowT', wire: 'num', channel: 'edge' },
      { name: 'damp', wire: 'num', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
    ],
    rosterFields: [
      { name: 'variant', wire: 'num', channel: 'edge' },
      { name: 'colorIdx', wire: 'num', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'enraged', wire: 'bool', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      // Segments carry these - a mid-flight joiner replays zeroed
      // timers without them (enrage pull + stall-breaker timing diverge
      // until the next segment lands).
      { name: 'et', wire: 'num', channel: 'edge' },
      { name: 'slowT', wire: 'num', channel: 'edge' },
      { name: 'damp', wire: 'num', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
    ],
  },
  creature: {
    kind: 'creature',
    verbs: { spawn: 'crawlSpawn', update: 'crawlEvt', gone: 'crawlDie', roster: 'crawlRoster' },
    fields: [
      { name: 'species', wire: 'str', channel: 'edge' },
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'uber', wire: 'bool', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'seed', wire: 'num', channel: 'edge' },
      { name: 'uber', wire: 'bool', channel: 'edge' },
      { name: 'species', wire: 'str', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
    ],
    goneFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'by', wire: 'str', channel: 'edge' },
    ],
    updateFields: [
      { name: 'kind', wire: 'str', channel: 'edge' },
      { name: 'sk', wire: 'num', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
      // Live LCG state on every edge - a lost edge that consumed a crand
      // draw offsets the replica's whole stream permanently otherwise
      // (join-time roster is the only other seed carrier).
      { name: 'seed', wire: 'num', channel: 'edge' },
    ],
    rosterFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'uber', wire: 'bool', channel: 'edge' },
      { name: 'seed', wire: 'num', channel: 'edge' },
      { name: 'species', wire: 'str', channel: 'edge' },
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'targetId', wire: 'str', channel: 'edge' },
      { name: 'tp', wire: 'vec3', channel: 'edge' },
      { name: 't', wire: 'num', channel: 'sim' },
      // Flyer orbit steering state - never rides edges, so without the
      // roster carrying it a stun/missed-edge offsets the replica's orbit
      // phase forever (up to 2*ORBIT_R standing divergence).
      { name: 'ph', wire: 'num', channel: 'edge' },
      { name: 'od', wire: 'num', channel: 'edge' },
    ],
  },
  deploy: {
    kind: 'deploy',
    verbs: { spawn: 'deploySpawn', update: 'deployHp', gone: 'deployGone' },
    fields: [
      { name: 'kind', wire: 'str', channel: 'edge' },
      { name: 'owner', wire: 'str', channel: 'edge' },
      { name: 'team', wire: 'str', channel: 'edge', absent: '' },
    ],
    spawnFields: [
      { name: 'owner', wire: 'str', channel: 'edge' },
      { name: 'kind', wire: 'str', channel: 'edge' },
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'team', wire: 'str', channel: 'edge' },
    ],
    updateFields: [
      { name: 'hp', wire: 'num', channel: 'echo' },
      { name: 'armor', wire: 'num', channel: 'echo' },
      { name: 'src', wire: 'str', channel: 'echo' },
    ],
    goneFields: [],
    // deployDown/deployUp are lifecycle notifies - a wreck flips DOWN
    // and back UP without leaving the roster.
    events: {
      deployDown: [
        { name: 'kind', wire: 'str', channel: 'edge' },
        { name: 'team', wire: 'str', channel: 'edge', absent: null },
        { name: 'respawnS', wire: 'num', channel: 'edge' },
      ],
      deployUp: [],
      // Deployable FX/outcome notifies - visual triggers; damage itself
      // always arrives through the player outcome events.
      turretShot: [
        { name: 'owner', wire: 'str', channel: 'edge' },
        { name: 'targetId', wire: 'str', channel: 'edge' },
      ],
      sentryShot: [
        { name: 'owner', wire: 'str', channel: 'edge' },
        { name: 'x', wire: 'num', channel: 'sim' },
        { name: 'y', wire: 'num', channel: 'sim' },
        { name: 'z', wire: 'num', channel: 'sim' },
      ],
      // Mortar turret: the launch VELOCITY rides the wire - clients spawn
      // a replica mortar shell on the exact arc the server solved; the
      // blast itself arrives via the scheduled bolt (mineBlast funnel).
      mortarShot: [
        { name: 'owner', wire: 'str', channel: 'edge' },
        { name: 'vx', wire: 'num', channel: 'sim' },
        { name: 'vy', wire: 'num', channel: 'sim' },
        { name: 'vz', wire: 'num', channel: 'sim' },
      ],
      mineBoom: [
        { name: 'owner', wire: 'str', channel: 'edge' },
        { name: 'pos', wire: 'vec3', channel: 'sim' },
      ],
      // Jump pad discharge - the whoosh/dust burst rides the launch
      // direction so the blast reads along the body's actual arc.
      padBoing: [
        { name: 'pos', wire: 'vec3', channel: 'sim' },
        { name: 'nx', wire: 'num', channel: 'sim' },
        { name: 'ny', wire: 'num', channel: 'sim' },
        { name: 'nz', wire: 'num', channel: 'sim' },
      ],
      // Loiter munition commits to a dive - the launch velocity rides the
      // wire so clients fly the replica on the identical line; the blast
      // itself arrives through the mineBoom funnel when the dive lands.
      loiterDive: [
        { name: 'pos', wire: 'vec3', channel: 'sim' },
        { name: 'vx', wire: 'num', channel: 'sim' },
        { name: 'vy', wire: 'num', channel: 'sim' },
        { name: 'vz', wire: 'num', channel: 'sim' },
      ],
      sensorPing: [
        { name: 'team', wire: 'str', channel: 'edge', absent: null },
        { name: 'targets', wire: 'arr', channel: 'edge' },
      ],
    },
    // gameState deployables[] row - hp/armor/team ride optional on the
    // snapshot row; spawn edges always carry the full set.
    rosterFields: [
      { name: 'owner', wire: 'str', channel: 'edge' },
      { name: 'kind', wire: 'str', channel: 'edge' },
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'hp', wire: 'num', channel: 'echo', absent: null },
      { name: 'armor', wire: 'num', channel: 'echo', absent: null },
      { name: 'team', wire: 'str', channel: 'edge', absent: null },
    ],
  },
  flag: {
    kind: 'flag',
    // flagUpdate IS the whole lifecycle - state/carrier/pos ride the
    // roster feed, so there are no spawn/gone edge verbs to declare.
    verbs: { update: 'flagUpdate' },
    fields: [
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'carrier', wire: 'str', channel: 'edge' },
    ],
    rosterFields: [
      // The flag's row key is its team - rosterRow writes it under the
      // idField ('team'), so it does not repeat here.
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'home', wire: 'vec3', channel: 'edge' },
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'carrier', wire: 'str', channel: 'edge' },
    ],
  },
  node: {
    kind: 'node',
    // nodeUpdate is the whole lattice lifecycle - ownership/build/hp all
    // ride the one roster feed (same pattern as flag). The hashed field
    // list holds edge-channel truth only: hp/build drift on the roster,
    // hashing them would be the phantom-desync class FIELD_CHANNELS bans.
    verbs: { update: 'nodeUpdate' },
    fields: [
      { name: 'owner', wire: 'str', channel: 'edge' },
    ],
    rosterFields: [
      // The row key is the node id - rosterRow writes it under 'id'.
      { name: 'gx', wire: 'num', channel: 'edge' },
      { name: 'gz', wire: 'num', channel: 'edge' },
      { name: 'pos', wire: 'vec3', channel: 'edge' },
      { name: 'owner', wire: 'str', channel: 'edge' },
      { name: 'hp', wire: 'num', channel: 'sim' },
      { name: 'maxHp', wire: 'num', channel: 'edge' },
      { name: 'build', wire: 'num', channel: 'sim' },
      { name: 'buildBy', wire: 'str', channel: 'edge' },
      { name: 'core', wire: 'bool', channel: 'edge' },
    ],
  },
  pickup: {
    kind: 'pickup',
    // Blast knocks rebroadcast pickupSpawn (the edge re-seats clients to
    // the new truth spot) - there is no distinct update verb.
    verbs: { spawn: 'pickupSpawn', gone: 'pickupGone' },
    fields: [
      { name: 'kind', wire: 'str', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'vel', wire: 'vec3', channel: 'sim', absent: null },
      { name: 'kind', wire: 'str', channel: 'edge' },
      // Token denomination (1/3/9/27); 1 for every other kind.
      { name: 'val', wire: 'num', channel: 'edge', absent: 1 },
    ],
    goneFields: [
      { name: 'by', wire: 'str', channel: 'edge' },
    ],
    // gameState pickups[] row - `kind` rides optional on the snapshot.
    rosterFields: [
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'vel', wire: 'vec3', channel: 'sim', absent: null },
      { name: 'kind', wire: 'str', channel: 'edge', absent: null },
      { name: 'val', wire: 'num', channel: 'edge', absent: 1 },
    ],
  },
  projectile: {
    kind: 'projectile',
    // Shells are edges-only: spawn edge + deterministic replay + destroy
    // - there is no update verb on the wire.
    verbs: { spawn: 'projectileCreated', gone: 'projectileDestroyed' },
    fields: [
      { name: 'weaponType', wire: 'num', channel: 'edge' },
      { name: 'ownerId', wire: 'str', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'projectileId', wire: 'str', channel: 'edge' },
      { name: 'ownerId', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'weaponType', wire: 'num', channel: 'edge' },
      // shotId/pellet echo back the client's intent nonce - bot-spawned
      // shells have none, so omission is legal.
      { name: 'shotId', wire: 'str', channel: 'echo', absent: null },
      { name: 'pellet', wire: 'num', channel: 'echo', absent: null },
      // The server shell's age AT SPAWN ECHO - nonzero when the intent
      // back-dated (lagS) or the echo rode a queue. Remote replicas
      // advance by this exactly (arrival-lag guesses mis-age the arc);
      // srvAge >= ttl means the shell died before it was seen - skip.
      { name: 'age', wire: 'num', channel: 'echo', absent: null },
      // Server wall-ms at broadcast - the client keeps a clock-offset
      // estimate (serverNowMs), so replica age = age + (serverNow − t)
      // is exact: intent lag + echo transit both measured, nothing
      // estimated. The age>sa traj-epoch class collapses to wire truth.
      { name: 't', wire: 'num', channel: 'echo', absent: null },
    ],
    // The contact point: replicas explode where the AUTHORITY detonated
    // the shell, not wherever their replay drifted to - a stamped blast
    // only dedupes its knockback echo when the centers match.
    goneFields: [
      { name: 'position', wire: 'vec3', channel: 'edge', absent: null },
      // Echo of the client's intent nonce - the parity ledger keys the
      // shell's fate by it (srvAt verdict). Absent on bot shells.
      { name: 'shotId', wire: 'str', channel: 'echo', absent: null },
      // The server shell's age at detonation - a still-flying replica is
      // `arrivalAge − srvAge` ahead of the fate, so trajDiv can compare
      // same-epoch positions instead of subtracting a ping estimate.
      { name: 'age', wire: 'num', channel: 'echo', absent: null },
    ],
    // Belt-sticky combo: `projectileId` is the RIDER glued dead-center
    // onto `host` - replicas parent to the host's path the same tick.
    events: {
      projRide: [
        { name: 'host', wire: 'str', channel: 'edge' },
      ],
    },
  },
  // The player lane: join announce / leave / gameState roster rows / the
  // per-tick record. Players are the only client-owned kind - the server
  // relays their claimed state rather than simming it, so their verbs
  // carry claimed values instead of sim-derived ones.
  player: {
    kind: 'player',
    verbs: { spawn: 'playerJoined', update: 'tickUpdate', gone: 'playerLeft', roster: 'gameState' },
    fields: [
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'health', wire: 'num', channel: 'echo' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      { name: 'team', wire: 'str', channel: 'edge', absent: null },
    ],
    // playerJoined announce - id rides the 'playerId' key, not 'id'.
    spawnFields: [
      { name: 'name', wire: 'str', channel: 'edge', absent: null },
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'team', wire: 'str', channel: 'edge', absent: null },
      { name: 'transport', wire: 'str', channel: 'edge', absent: null },
      { name: 'armorClass', wire: 'str', channel: 'edge' },
      { name: 'weapon', wire: 'num', channel: 'edge', absent: null },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
    ],
    goneFields: [],
    // Player outcome events - server-declared results. Optional wire
    // fields carry `absent` so omission stays legal.
    events: {
      playerHit: [
        { name: 'shooterId', wire: 'str', channel: 'edge' },
        { name: 'damage', wire: 'num', channel: 'sim' },
        { name: 'health', wire: 'num', channel: 'sim' },
        { name: 'armor', wire: 'num', channel: 'sim', absent: null },
        { name: 'seq', wire: 'num', channel: 'echo', absent: null },
        { name: 'shotId', wire: 'str', channel: 'echo', absent: null },
        // Ghost delta (m): how far the rewind ghost the hit credited on
        // sat off the victim's live truth - only sent when >1.5m so the
        // shooter sees the cheap-hit discrepancy live.
        { name: 'gd', wire: 'num', channel: 'echo', absent: null },
      ],
      playerKill: [
        { name: 'shooterId', wire: 'str', channel: 'edge' },
        { name: 'weapon', wire: 'num', channel: 'edge', absent: null },
        { name: 'streak', wire: 'num', channel: 'edge', absent: null },
        { name: 'air', wire: 'num', channel: 'echo', absent: null },
        // Lifesteal perk paid out on this frag - drives the red implode
        // VFX on the killer; declared so the effect never plays for a
        // melee kill that didn't heal.
        { name: 'steal', wire: 'bool', channel: 'edge', absent: null },
      ],
      teamUpdate: [
        { name: 'team', wire: 'str', channel: 'edge' },
      ],
      // Headhunt: carrier's new held-token total after a grab/drop.
      playerHeld: [
        { name: 'n', wire: 'num', channel: 'edge' },
      ],
      knockback: [
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'force', wire: 'num', channel: 'sim' },
        { name: 'pull', wire: 'bool', channel: 'edge', absent: null },
        { name: 'yank', wire: 'bool', channel: 'edge', absent: null },
      ],
      playerRespawn: [
        { name: 'internalId', wire: 'str', channel: 'edge' },
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'rotation', wire: 'rot', channel: 'sim' },
        { name: 'armorClass', wire: 'str', channel: 'edge', absent: null },
        { name: 'health', wire: 'num', channel: 'edge', absent: 100 },
      ],
      teleport: [
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'velocity', wire: 'vec3', channel: 'sim' },
      ],
      // Server-measured hard landing - remote slam dressing for
      // observers (the owner's local sim already played theirs).
      landed: [
        { name: 'playerId', wire: 'str', channel: 'edge' },
        { name: 'pos', wire: 'vec3', channel: 'sim' },
        { name: 'impact', wire: 'num', channel: 'sim' },
      ],
    },
    // tickUpdate record - id rides 'playerId'; the binary tick frame
    // packs the same fields.
    updateFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      // Wire-optional below - the binary frame and old JSON senders omit
      // them when unset; `absent` marks omission as legal, not drift.
      { name: 'ping', wire: 'num', channel: 'sim', absent: null },
      { name: 'ski', wire: 'num', channel: 'sim', absent: null },
      { name: 'jet', wire: 'num', channel: 'sim', absent: null },
      { name: 'status', wire: 'num', channel: 'edge', absent: null },
      { name: 'sheep', wire: 'num', channel: 'sim', absent: null },
    ],
    // The tickUpdate envelope - ack/watermark keys wrap the row list.
    // Only `updates` is unconditional; the ack trio rides optional.
    updateEnvelope: [
      { name: 'updates', wire: 'arr', channel: 'edge' },
      { name: 'ackSeq', wire: 'num', channel: 'edge', absent: null },
      { name: 'inputAck', wire: 'num', channel: 'edge', absent: null },
      { name: 'tickSeq', wire: 'num', channel: 'edge', absent: null },
      { name: 'count', wire: 'num', channel: 'edge', absent: null },
    ],
    // The gameState envelope's own fields - every key sendWorldState /
    // handleSpectatorHandshake may write. Most are conditional payloads
    // (scores only in team modes, map only when the room carries one),
    // so all declare `absent` - only the two always-written keys warn.
    envelope: [
      { name: 'players', wire: 'arr', channel: 'edge' },
      { name: 'protocolVersion', wire: 'num', channel: 'edge' },
      { name: 'sessionToken', wire: 'str', channel: 'edge', absent: null },
      { name: 'wireIds', wire: 'obj', channel: 'edge', absent: null },
      { name: 'room', wire: 'str', channel: 'edge', absent: null },
      { name: 'mode', wire: 'str', channel: 'edge', absent: null },
      { name: 'instagib', wire: 'bool', channel: 'edge', absent: null },
      { name: 'gungame', wire: 'bool', channel: 'edge', absent: null },
      { name: 'igun', wire: 'bool', channel: 'edge', absent: null },
      { name: 'mapName', wire: 'str', channel: 'edge', absent: null },
      { name: 'team', wire: 'str', channel: 'edge', absent: null },
      { name: 'localPlayerState', wire: 'obj', channel: 'edge', absent: null },
      { name: 'scores', wire: 'obj', channel: 'edge', absent: null },
      { name: 'ffaScores', wire: 'obj', channel: 'edge', absent: null },
      { name: 'pickups', wire: 'arr', channel: 'edge', absent: null },
      { name: 'flags', wire: 'arr', channel: 'edge', absent: null },
      { name: 'deployables', wire: 'arr', channel: 'edge', absent: null },
      { name: 'matchEndsAt', wire: 'num', channel: 'edge', absent: null },
      { name: 'respawnMs', wire: 'num', channel: 'edge', absent: null },
      { name: 'map', wire: 'obj', channel: 'edge', absent: null },
    ],
    // gameState player row - id rides 'id' here (GameStatePlayer.id),
    // unlike the verbs' playerId.
    rosterFields: [
      { name: 'name', wire: 'str', channel: 'edge', absent: null },
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'status', wire: 'num', channel: 'edge' },
      { name: 'held', wire: 'num', channel: 'edge', absent: null },
      { name: 'team', wire: 'str', channel: 'edge', absent: null },
      { name: 'transport', wire: 'str', channel: 'edge', absent: null },
      { name: 'armorClass', wire: 'str', channel: 'edge' },
      // Server-known current weapon (bot loadout / last simmed spawn) -
      // lets a remote draw a real gun before any shot edge reveals it.
      { name: 'weapon', wire: 'num', channel: 'edge', absent: null },
    ],
  },
};

/** The emit-side field contract - one body for verbs, roster rows, and
 *  events. An emit that forgets a declared field used to sail out as
 *  null and the client diffs forever; null IS legit when the
 *  declaration names an `absent` sentinel, so only yell for
 *  undeclared-as-absent gaps, and never for explicit-null optionals. */
function emitFields(
  kind: WorldKindDecl,
  label: string,
  fields: KindFieldDecl[] | undefined,
  idField: string,
  vals: Record<string, unknown>,
  msg: Record<string, unknown>,
): void {
  for (const f of fields ?? []) {
    // The id field is declared for documentation but already written -
    // skip it or a vals-less emit would overwrite the id with null.
    if (f.name === idField) {continue;}
    if (!(f.name in vals)) {
      if (f.absent === undefined) {
        warnOnce(`${kind.kind}.${label}:${f.name}`, `[worldModel] ${kind.kind}.${label} emit missing declared field '${f.name}'`);
      }
    } else if (vals[f.name] != null && !wireOk(f.wire, vals[f.name])) {
      warnOnce(`${kind.kind}.${label}:${f.name}!t`, `[worldModel] ${kind.kind}.${label} emit field '${f.name}' wrong type (want ${f.wire})`);
    }
    msg[f.name] = vals[f.name] ?? f.absent ?? null;
  }
}



/** Build a lifecycle payload from the declared field list - the emitter
 *  supplies the values; the declared ORDER and field set own the wire
 *  shape, so a field can't drift into a message the client's handler
 *  never reads. Values absent from `vals` become the declared `absent`
 *  sentinel or null. */
export function verbPayload(
  kind: WorldKindDecl,
  verb: 'spawn' | 'update' | 'gone',
  idField: string,
  id: number | string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  let fields = kind.goneFields;
  if (verb === 'spawn') {fields = kind.spawnFields;}
  else if (verb === 'update') {fields = kind.updateFields;}
  const msg: Record<string, unknown> = { type: kind.verbs[verb], [idField]: id };
  emitFields(kind, kind.verbs[verb]!, fields, idField, vals, msg);
  return msg;
}
function warnOnce(key: string, text: string): void {
  const now = sharedNow();
  const last = warnOnceSeen.get(key);
  if (last !== undefined && now - last < WARN_ONCE_MS) {return;}
  warnOnceSeen.set(key, now);
  // oxlint-disable-next-line no-console
  console.warn(text);
}


/** Shape check for a declared wire type - presence alone can't catch a
 *  field that arrives as the wrong kind of value. */
function isVec3(v: unknown): boolean {
  const o = v as { x?: unknown; y?: unknown; z?: unknown } | null;
  return typeof o === 'object' && o !== null &&
    typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number';
}

function isRot(v: unknown): boolean {
  const o = v as { yaw?: unknown; pitch?: unknown } | null;
  return typeof o === 'object' && o !== null &&
    typeof o.yaw === 'number' && typeof o.pitch === 'number';
}

function wireOk(wire: KindFieldDecl['wire'], v: unknown): boolean {
  switch (wire) {
    case 'num': { return typeof v === 'number' && Number.isFinite(v);
    }
    case 'str': { return typeof v === 'string';
    }
    case 'bool': { return typeof v === 'boolean';
    }
    case 'arr': { return Array.isArray(v);
    }
    case 'obj': { return typeof v === 'object' && v !== null;
    }
    case 'vec3': { return isVec3(v);
    }
    case 'rot': { return isRot(v);
    }
    default: { const _exhaustive: never = wire; return _exhaustive; }
}
}



/** One roster row - id plus each declared roster field in order. Same
 *  contract as verbPayload: the declared field set owns the wire shape. */
export function rosterRow(
  kind: WorldKindDecl,
  idField: string,
  id: number | string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = { [idField]: id };
  emitFields(kind, 'roster', kind.rosterFields, idField, vals, row);
  return row;
}

/** Inverse of verbPayload for the consumer side: copy each declared
 *  field present on an inbound row into a patch - undefined keys mean
 *  "row didn't carry it, keep the stored value". Copying is the whole
 *  point: a declared field a consumer forgot to read can't drift the
 *  replica away from the wire again. Empty-string counts as absent
 *  (wire never carries it meaningfully); 0/false are real values. */
export function rowPatch(fields: KindFieldDecl[], row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const v = row[f.name];
    if (v === undefined || v === null || v === '') {continue;}
    patch[f.name] = v;
  }
  return patch;
}

/** Spawn-half convenience - most emits only need the spawn verb. */
export function spawnPayload(
  kind: WorldKindDecl,
  id: number | string,
  idField: string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  return verbPayload(kind, 'spawn', idField, id, vals);
}

/** One-off lifecycle notify payload - same contract as verbPayload but
 *  the field list lives under kind.events[type] (deployDown, deployUp). */
export function eventPayload(
  kind: WorldKindDecl,
  type: string,
  idField: string,
  id: number | string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  const fields = kind.events?.[type];
  const msg: Record<string, unknown> = { type, [idField]: id };
  emitFields(kind, type, fields, idField, vals, msg);
  return msg;
}

/** Inbound half of the emit guard: a packet that drops a declared field
 *  warns once at dispatch - same contract as verbPayload's emit-side
 *  warn (absent sentinel or optional = fine). Fields the sender legit
 *  omits (`absent` declared) stay quiet. */
export function checkPacket(
  kind: WorldKindDecl,
  verb: 'spawn' | 'update' | 'gone' | (string & {}),
  msg: Record<string, unknown>,
): void {
  let fields = kind.events?.[verb];
  if (verb === 'spawn') {fields = kind.spawnFields;}
  // flag-style kinds whose update verb IS the roster broadcast check
  // rows against rosterFields - there is no per-row updateFields list.
  else if (verb === 'update') {fields = kind.updateFields ?? kind.rosterFields;}
  else if (verb === 'gone') {fields = kind.goneFields;}
  else if (verb === 'roster') {fields = kind.rosterFields;}
  const label = verb in kind.verbs ? (kind.verbs as Record<string, string>)[verb]! : verb;
  // One field-list check for every surface - rows, cross-kind roster
  // containers, and envelopes share the contract: absent-declared fields
  // may be missing, null is the wire's absent sentinel, anything else
  // must satisfy wireOk.
  const checkFields = (fs: KindFieldDecl[] | undefined, m: Record<string, unknown>, tag: string): void => {
    for (const f of fs ?? []) {
      if (!(f.name in m)) {
        if (f.absent === undefined) {
          warnOnce(`${kind.kind}.${label}:${tag}${f.name}`, `[worldModel] inbound ${kind.kind}.${label} ${tag}missing declared field '${f.name}'`);
        }
        continue;
      }
      if (m[f.name] != null && !wireOk(f.wire, m[f.name])) {
        warnOnce(`${kind.kind}.${label}:${tag}${f.name}!t`, `[worldModel] inbound ${kind.kind}.${label} ${tag}field '${f.name}' wrong type (want ${f.wire})`);
      }
    }
  };
  const check = (m: Record<string, unknown>): void => checkFields(fields, m, '');
  // Row-wrapped verbs (tickUpdate's updates[], roster arrays) check each
  // row - the fields live there, not at message level. Roster feeds pick
  // the container for THEIR kind: gameState carries every roster, so a
  // blind first-array pick would check ball rows against player fields.
  const ROSTER_ROWS: Record<string, string> = { ball: 'balls', creature: 'crawlers', flag: 'flags', node: 'nodes', player: 'players', pickup: 'pickups', deploy: 'deployables' };
  if (verb === 'roster') {
    // A roster feed may carry several kinds (gameState ships them all) -
    // sweep every declared container present, not just the caller's.
    for (const k of Object.values(WORLD_MODEL)) {
      if (!k.rosterFields || k === kind) {continue;}
      const extra = msg[ROSTER_ROWS[k.kind]!];
      if (Array.isArray(extra)) {
        for (const r of extra) {checkFields(k.rosterFields, r as Record<string, unknown>, `${k.kind} `);}
      }
    }
    const rows = ROSTER_ROWS[kind.kind] ? msg[ROSTER_ROWS[kind.kind]!] : undefined;
    if (Array.isArray(rows)) { for (const r of rows) {check(r as Record<string, unknown>);} }
    // The envelope's own fields - the roster containers get row-checked
    // above; this verifies the message-level payload (players[],
    // protocolVersion, map, scores, ...) carries its declared shape.
    if (kind.envelope) {checkFields(kind.envelope, msg, 'env:');}
    return;
  }
  // Update envelopes (tickUpdate's ack/count keys) wrap the row list -
  // checked before the row branch since updates[] returns early.
  if (verb === 'update' && kind.updateEnvelope) {checkFields(kind.updateEnvelope, msg, 'env:');}
  const rows = msg.updates ?? msg.balls ?? msg.crawlers ?? msg.flags ?? msg.players;
  if (Array.isArray(rows)) { for (const r of rows) {check(r as Record<string, unknown>);} return; }
  check(msg);
}

/** Inbound intent declarations - client→server required fields per
 *  ClientMessage union member. Optional union fields are declared with
 *  `absent` for documentation; only a field with NO absent marker warns
 *  when missing, matching the emit-side contract. A hostile or buggy
 *  client that drops a required field warns once at dispatch instead of
 *  the handler reading `undefined.x` five frames later. */
export interface IntentFieldDecl { name: string; wire?: KindFieldDecl['wire']; absent?: unknown }
export const CLIENT_INTENTS: Record<string, IntentFieldDecl[]> = {
  join: [{ name: 'playerId', wire: 'str' }, { name: 'token', wire: 'str', absent: null }, { name: 'room', wire: 'str', absent: null }, { name: 'mode', wire: 'str', absent: null }, { name: 'perk', wire: 'str', absent: null }, { name: 'armorClass', wire: 'str', absent: null }, { name: 'skill', wire: 'str', absent: null }, { name: 'name', wire: 'str', absent: null }, { name: 'map', wire: 'str', absent: null }, { name: 'bots', wire: 'num', absent: null }, { name: 'unlisted', wire: 'bool', absent: null }, { name: 'noCreatures', wire: 'bool', absent: null }, { name: 'noBalls', wire: 'bool', absent: null }, { name: 'instagib', wire: 'bool', absent: null }, { name: 'gungame', wire: 'bool', absent: null }, { name: 'igun', wire: 'bool', absent: null }, { name: 'spawnHold', wire: 'bool', absent: null }, { name: 'transport', wire: 'str', absent: null }, { name: 'resumeSeq', wire: 'num', absent: null }],
  position: [{ name: 'position', wire: 'vec3' }, { name: 'rotation', wire: 'rot' }, { name: 'velocity', wire: 'vec3' }, { name: 'seq', wire: 'num', absent: null }, { name: 'inputSeq', wire: 'num', absent: null }, { name: 'ping', wire: 'num', absent: null }],
  teleport: [{ name: 'position', wire: 'vec3' }, { name: 'rotation', wire: 'rot' }, { name: 'velocity', wire: 'vec3' }],
  ping: [{ name: 'timestamp', wire: 'num' }],
  pong: [{ name: 'timestamp', wire: 'num' }],
  clientStats: [{ name: 'fps', wire: 'num' }, { name: 'jsMs', wire: 'num' }, { name: 'ping', wire: 'num' }, { name: 'loss', wire: 'num' }, { name: 'jitter', wire: 'num' }, { name: 'renderLagMs', wire: 'num', absent: null }, { name: 'renderLag', wire: 'obj', absent: null }, { name: 'gap', wire: 'num', absent: null }, { name: 'starve', wire: 'num', absent: null }, { name: 'starveMs', wire: 'num', absent: null }, { name: 'drainMsMax', wire: 'num', absent: null }],
  chat: [{ name: 'text', wire: 'str' }, { name: 'team', wire: 'bool', absent: null }, { name: 'vgs', wire: 'str', absent: null }],
  aoeShot: [{ name: 'position', wire: 'vec3' }, { name: 'weaponType', wire: 'num', absent: null }, { name: 'excludeTargetId', wire: 'str', absent: null }, { name: 'projectileId', wire: 'str', absent: null }, { name: 'airtime', wire: 'num', absent: null }, { name: 'power', wire: 'num', absent: null }, { name: 'directHit', wire: 'bool', absent: null }, { name: 'shotId', wire: 'str', absent: null }, { name: 'fireAt', wire: 'num', absent: null }],
  shotFired: [{ name: 'weaponType', wire: 'num', absent: null }, { name: 'dir', wire: 'vec3', absent: null }, { name: 'pos', wire: 'vec3', absent: null }, { name: 'vel', wire: 'vec3', absent: null }, { name: 'shotId', wire: 'str', absent: null }, { name: 'fireAt', wire: 'num', absent: null }],
  jump: [{ name: 'position', wire: 'vec3' }],
  jetpack: [{ name: 'position', wire: 'vec3' }],
  inputMove: [{ name: 'input', wire: 'obj' }, { name: 'rotation', wire: 'rot' }, { name: 'seq', wire: 'num', absent: null }, { name: 'prev', wire: 'obj', absent: null }],
  projectileDestroy: [{ name: 'projectileId', wire: 'str' }, { name: 'shotId', wire: 'str', absent: null }],
  environmentDamage: [{ name: 'amount', wire: 'num' }, { name: 'attacker', wire: 'str', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  heal: [{ name: 'amount', wire: 'num' }, { name: 'claimSeq', wire: 'num', absent: null }],
  creatureHit: [{ name: 'id', wire: 'num' }, { name: 'damage', wire: 'num' }, { name: 'kx', wire: 'num', absent: null }, { name: 'ky', wire: 'num', absent: null }, { name: 'kz', wire: 'num', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  // crawlerHit carries no knockback - the crawler channel is melee-PvE
  // and the validator drops kx/ky/kz on purpose (see wire.ts).
  crawlerHit: [{ name: 'id', wire: 'num' }, { name: 'damage', wire: 'num' }, { name: 'claimSeq', wire: 'num', absent: null }],
  deploy: [{ name: 'kind', wire: 'str' }, { name: 'position', wire: 'vec3' }, { name: 'vel', wire: 'vec3', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  repair: [{ name: 'targetId', wire: 'num' }, { name: 'claimSeq', wire: 'num', absent: null }],
  skillUse: [{ name: 'claimSeq', wire: 'num', absent: null }],
  slam: [{ name: 'position', wire: 'vec3' }, { name: 'claimSeq', wire: 'num', absent: null }],
  respawn: [{ name: 'hold', wire: 'bool', absent: null }],
  ready: [],
  throwFlag: [],
  tickNack: [],
  snapshotRequest: [],
  resync: [],
  classUpdate: [{ name: 'armorClass', wire: 'str' }],
  perkUpdate: [{ name: 'perk', wire: 'str' }],
  switchRoom: [{ name: 'room', wire: 'str', absent: null }, { name: 'mode', wire: 'str', absent: null }, { name: 'map', wire: 'str', absent: null }, { name: 'bots', wire: 'num', absent: null }, { name: 'unlisted', wire: 'bool', absent: null }, { name: 'noCreatures', wire: 'bool', absent: null }, { name: 'noBalls', wire: 'bool', absent: null }, { name: 'instagib', wire: 'bool', absent: null }, { name: 'gungame', wire: 'bool', absent: null }, { name: 'igun', wire: 'bool', absent: null }],
};

// Any warn here repeats per packet/emit - a hostile peer or a broken
// emit inside a per-entity loop would flood the log. Throttle per key so
const WARN_ONCE_MS = 5000;


/** Inbound twin of checkPacket: required intent fields missing from a
 *  client packet warn at dispatch. Message types with no declaration
 *  stay unchecked (e.g. a union member added before its intent lands). */
export function checkIntent(type: string, msg: Record<string, unknown>): void {
  const fields = CLIENT_INTENTS[type];
  if (!fields) {return;}
  for (const f of fields) {
    if (f.name in msg && f.wire && msg[f.name] != null && !wireOk(f.wire, msg[f.name])) {
      warnOnce(`${type}:${f.name}!t`, `[worldModel] inbound intent ${type} field '${f.name}' wrong type (want ${f.wire})`);
    }
    if (!(f.name in msg) && f.absent === undefined) {
      warnOnce(`${type}:${f.name}`, `[worldModel] inbound intent '${type}' missing required field '${f.name}'`);
    }
  }
}

/** Wire-verb → (kind, verb) index for inbound checking - the dispatcher
 *  looks a message type up here instead of mapping verbs by hand. */
const VERB_INDEX = new Map<string, { kind: WorldKindDecl; verb: string }>();
for (const k of Object.values(WORLD_MODEL)) {
  for (const v of ['spawn', 'update', 'gone', 'roster'] as const) {
    if (k.verbs[v]) {VERB_INDEX.set(k.verbs[v]!, { kind: k, verb: v });}
  }
  // Event notifies index under their own wire type, not a verb slot.
  for (const t of Object.keys(k.events ?? {})) {
    VERB_INDEX.set(t, { kind: k, verb: t });
  }
}
export function verbForType(type: string): { kind: WorldKindDecl; verb: string } | undefined {
  return VERB_INDEX.get(type);
}

/** The per-id field tuple a hash-miss diff carries for a kind - the
 *  ORDER comes from the declaration, so the server's emit and the
 *  client's diff can never disagree about which slot is which field. */
export function fieldNames(kind: WorldKindDecl): string[] {
  return kind.fields.map((f): string => f.name);
}

/** Union of a kind's declared field names across the given slots -
 *  consumers derive "every field this kind can carry" instead of
 *  re-listing them (the client player roster's patch list is exactly
 *  spawn ∪ update ∪ roster - a second hand-written list would drift). */
export function declaredFieldNames(
  kind: WorldKindDecl,
  ...slots: ('fields' | 'spawnFields' | 'updateFields' | 'rosterFields' | 'goneFields')[]
): string[] {
  const out: string[] = [];
  for (const s of slots) {
    for (const f of kind[s] ?? []) {
      if (!out.includes(f.name)) {out.push(f.name);}
    }
  }
  return out;
}

/** Emit `fields` for every entity in a roster - id first, then each
 *  declared field in declaration order. The tuple's element type is the
 *  declared fields' types; callers cast to their wire slot. */
export function kindFields(kind: WorldKindDecl, roster: Iterable<{ id: number }>): unknown[][] {
  const decls = kind.fields;
  const out: unknown[][] = [];
  for (const e of roster) {
    const r = e as unknown as Record<string, unknown>;
    out.push([e.id, ...decls.map((d): object | null => r[d.name] ?? d.absent ?? null)]);
  }
  return out;
}

/** Client half of the hash-miss diff: compare the server's emitted field
 *  tuples against the local replica map by DECLARED field name - the
 *  same list the emit used, so a new hashed field diffs on both ends
 *  automatically. Returns descriptive strings (`#id:missing`,
 *  `#id:stranded`, `#id:field local/remote`). */
export function kindFieldDiffs(
  kind: WorldKindDecl,
  local: Map<number, Record<string, unknown>>,
  serverFields: readonly (readonly unknown[])[] | undefined,
): { diffs: string[]; keys: Set<string> } {
  const diffs: string[] = [];
  const keys = new Set<string>();
  if (!serverFields) {return { diffs, keys };}
  const seen = new Set<number>();
  for (const row of serverFields) {
    const id = row[0] as number;
    seen.add(id);
    const l = local.get(id);
    if (!l) { diffs.push(`#${id}:missing`); keys.add(`${id}:missing`); continue; }
    for (let i = 0; i < kind.fields.length; i += 1) {
      const f = kind.fields[i]!;
      const remote = row[i + 1];
      const lv = l[f.name] ?? f.absent ?? null;
      if (lv !== (remote ?? f.absent ?? null)) {
        diffs.push(`#${id}:${f.name} ${lv}/${remote}`);
        keys.add(`${id}:${f.name}`);
      }
    }
  }
  for (const id of local.keys()) {
    if (!seen.has(id)) { diffs.push(`#${id}:stranded`); keys.add(`${id}:stranded`); }
  }
  return { diffs, keys };
}
