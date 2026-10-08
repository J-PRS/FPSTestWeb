// One world model — the C5 backbone. Every interactive entity kind
// declares itself ONCE here: which fields ride which sync channel
// (sim/edge/echo — same taxonomy as FIELD_CHANNELS) and which wire verbs
// carry its lifecycle. The spawn/gone/hash/diff surfaces are DERIVED
// from this declaration instead of hand-maintained in five places, so
// adding a field or a kind can't drift one lane out of sync with the
// rest — the Nth-copy-of-the-same-drift-bug class.
//
// Migration is incremental: a kind joins the table when its declaration
// is complete, and each consumer (hash diff, snapshot emit, spawn
// payload) moves onto the generated surface one at a time. 'ball' is
// the pilot — its edges and hash inputs already exist, so only the
// declaration is new.

import type { SyncChannel } from './stateHash.ts';
import { sharedNow } from './env.ts';

export interface KindFieldDecl {
  /** Field name on the sim's entity record (server) and the client replica. */
  name: string;
  /** Wire type — lets inbound checks verify SHAPE, not just presence: a
   *  string where a vec3 belongs poisons a replica as silently as a
   *  missing field. 'vec3' = {x,y,z} finite numbers; 'rot' = {yaw,pitch}; 'arr' = any array; 'obj' = any non-null object. */
  wire: 'num' | 'str' | 'bool' | 'vec3' | 'rot' | 'arr' | 'obj';
  channel: SyncChannel;
  /** Value emitted when the field is absent — the wire's sentinel for
   *  'not set' (deploy teams diff '' server-side, never null). */
  absent?: unknown;
}

export interface WorldKindDecl {
  /** Wire verb prefix: ball => ballSpawn / ballSegment / ballDie. */
  kind: string;
  verbs: { spawn?: string; update?: string; gone?: string; roster?: string };
  /** Lifecycle/mirrored fields a replica MUST agree on — hashed + diffed. */
  fields: KindFieldDecl[];
  /** Spawn payload shape — the full field list a spawn message carries,
   *  in wire order. Declared so the emit can't add a field the client's
   *  spawn handler doesn't consume. */
  spawnFields?: KindFieldDecl[];
  /** Gone payload shape — fields past the id a destroy message carries. */
  goneFields?: KindFieldDecl[];
  /** Update payload shape — fields past the id an update message carries
   *  (only for kinds whose update rides a JSON verb; binary updaters like
   *  ballSegment encode their own frame). */
  updateFields?: KindFieldDecl[];
  /** Roster row shape — the field list a join-time roster row carries.
   *  Spawn ⊄ roster: the roster adds live sim state (enraged, sim state)
   *  the spawn already derived. */
  rosterFields?: KindFieldDecl[];
  /** One-off lifecycle notifies that aren't spawn/update/gone — keyed by
   *  wire type (deployDown, deployUp). Same declared-shape contract:
   *  the emit and the inbound check both read this list. */
  events?: Record<string, KindFieldDecl[]>;
  /** Message-level fields of the roster envelope itself (gameState's
   *  room/mode/scores/map/... — the roster sweep covers ROWS, this
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
    // ballSegment rides a packed binary frame (wire.ts), not JSON — the
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
    // deployDown/deployUp are lifecycle notifies — a wreck flips DOWN
    // and back UP without leaving the roster.
    events: {
      deployDown: [
        { name: 'kind', wire: 'str', channel: 'edge' },
        { name: 'team', wire: 'str', channel: 'edge', absent: null },
        { name: 'respawnS', wire: 'num', channel: 'edge' },
      ],
      deployUp: [],
      // Deployable FX/outcome notifies — visual triggers; damage itself
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
      mineBoom: [
        { name: 'owner', wire: 'str', channel: 'edge' },
        { name: 'pos', wire: 'vec3', channel: 'sim' },
      ],
      sensorPing: [
        { name: 'team', wire: 'str', channel: 'edge', absent: null },
        { name: 'targets', wire: 'arr', channel: 'edge' },
      ],
    },
    // gameState deployables[] row — hp/armor/team ride optional on the
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
    // flagUpdate IS the whole lifecycle — state/carrier/pos ride the
    // roster feed, so there are no spawn/gone edge verbs to declare.
    verbs: { update: 'flagUpdate' },
    fields: [
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'carrier', wire: 'str', channel: 'edge' },
    ],
    rosterFields: [
      // The flag's row key is its team — rosterRow writes it under the
      // idField ('team'), so it does not repeat here.
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'home', wire: 'vec3', channel: 'edge' },
      { name: 'state', wire: 'str', channel: 'edge' },
      { name: 'carrier', wire: 'str', channel: 'edge' },
    ],
  },
  pickup: {
    kind: 'pickup',
    // Blast knocks rebroadcast pickupSpawn (the edge re-seats clients to
    // the new truth spot) — there is no distinct update verb.
    verbs: { spawn: 'pickupSpawn', gone: 'pickupGone' },
    fields: [
      { name: 'kind', wire: 'str', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'kind', wire: 'str', channel: 'edge' },
    ],
    goneFields: [
      { name: 'by', wire: 'str', channel: 'edge' },
    ],
    // gameState pickups[] row — `kind` rides optional on the snapshot.
    rosterFields: [
      { name: 'pos', wire: 'vec3', channel: 'sim' },
      { name: 'kind', wire: 'str', channel: 'edge', absent: null },
    ],
  },
  projectile: {
    kind: 'projectile',
    // Shells are edges-only: spawn edge + deterministic replay + destroy
    // — there is no update verb on the wire.
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
      // shotId/pellet echo back the client's intent nonce — bot-spawned
      // shells have none, so omission is legal.
      { name: 'shotId', wire: 'str', channel: 'echo', absent: null },
      { name: 'pellet', wire: 'num', channel: 'echo', absent: null },
    ],
    goneFields: [],
  },
  // The player lane: join announce / leave / gameState roster rows / the
  // per-tick record. Players are the only client-owned kind — the server
  // relays their claimed state rather than simming it, so their verbs
  // carry claimed values instead of sim-derived ones.
  player: {
    kind: 'player',
    verbs: { spawn: 'playerJoined', update: 'tickUpdate', gone: 'playerLeft', roster: 'gameState' },
    fields: [
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'health', wire: 'num', channel: 'echo' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      { name: 'team', wire: 'str', channel: 'edge' },
    ],
    // playerJoined announce — id rides the 'playerId' key, not 'id'.
    spawnFields: [
      { name: 'name', wire: 'str', channel: 'edge' },
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'team', wire: 'str', channel: 'edge' },
      { name: 'transport', wire: 'str', channel: 'edge' },
      { name: 'armorClass', wire: 'str', channel: 'edge' },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
    ],
    goneFields: [],
    // Player outcome events — server-declared results. Optional wire
    // fields carry `absent` so omission stays legal.
    events: {
      playerHit: [
        { name: 'shooterId', wire: 'str', channel: 'edge' },
        { name: 'damage', wire: 'num', channel: 'sim' },
        { name: 'health', wire: 'num', channel: 'sim' },
        { name: 'armor', wire: 'num', channel: 'sim', absent: null },
        { name: 'seq', wire: 'num', channel: 'echo', absent: null },
        { name: 'shotId', wire: 'str', channel: 'echo', absent: null },
      ],
      playerKill: [
        { name: 'shooterId', wire: 'str', channel: 'edge' },
        { name: 'weapon', wire: 'num', channel: 'edge', absent: null },
        { name: 'streak', wire: 'num', channel: 'edge', absent: null },
        { name: 'air', wire: 'num', channel: 'echo', absent: null },
      ],
      teamUpdate: [
        { name: 'team', wire: 'str', channel: 'edge' },
      ],
      knockback: [
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'force', wire: 'num', channel: 'sim' },
        { name: 'pull', wire: 'bool', channel: 'edge', absent: null },
      ],
      playerRespawn: [
        { name: 'internalId', wire: 'str', channel: 'edge' },
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'rotation', wire: 'rot', channel: 'sim' },
        { name: 'armorClass', wire: 'str', channel: 'edge', absent: null },
      ],
      teleport: [
        { name: 'position', wire: 'vec3', channel: 'sim' },
        { name: 'velocity', wire: 'vec3', channel: 'sim' },
      ],
    },
    // tickUpdate record — id rides 'playerId'; the binary tick frame
    // packs the same fields.
    updateFields: [
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      // Wire-optional below — the binary frame and old JSON senders omit
      // them when unset; `absent` marks omission as legal, not drift.
      { name: 'ping', wire: 'num', channel: 'sim', absent: null },
      { name: 'ski', wire: 'num', channel: 'sim', absent: null },
      { name: 'status', wire: 'num', channel: 'edge', absent: null },
      { name: 'sheep', wire: 'num', channel: 'sim', absent: null },
    ],
    // The tickUpdate envelope — ack/watermark keys wrap the row list.
    // Only `updates` is unconditional; the ack trio rides optional.
    updateEnvelope: [
      { name: 'updates', wire: 'arr', channel: 'edge' },
      { name: 'ackSeq', wire: 'num', channel: 'edge', absent: null },
      { name: 'inputAck', wire: 'num', channel: 'edge', absent: null },
      { name: 'tickSeq', wire: 'num', channel: 'edge', absent: null },
      { name: 'count', wire: 'num', channel: 'edge', absent: null },
    ],
    // The gameState envelope's own fields — every key sendWorldState /
    // handleSpectatorHandshake may write. Most are conditional payloads
    // (scores only in team modes, map only when the room carries one),
    // so all declare `absent` — only the two always-written keys warn.
    envelope: [
      { name: 'players', wire: 'arr', channel: 'edge' },
      { name: 'protocolVersion', wire: 'num', channel: 'edge' },
      { name: 'sessionToken', wire: 'str', channel: 'edge', absent: null },
      { name: 'wireIds', wire: 'obj', channel: 'edge', absent: null },
      { name: 'room', wire: 'str', channel: 'edge', absent: null },
      { name: 'mode', wire: 'str', channel: 'edge', absent: null },
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
    // gameState player row — id rides 'id' here (GameStatePlayer.id),
    // unlike the verbs' playerId.
    rosterFields: [
      { name: 'name', wire: 'str', channel: 'edge' },
      { name: 'internalId', wire: 'str', channel: 'edge' },
      { name: 'position', wire: 'vec3', channel: 'sim' },
      { name: 'rotation', wire: 'rot', channel: 'sim' },
      { name: 'velocity', wire: 'vec3', channel: 'sim' },
      { name: 'isDead', wire: 'bool', channel: 'edge' },
      { name: 'health', wire: 'num', channel: 'sim' },
      { name: 'status', wire: 'num', channel: 'edge' },
      { name: 'team', wire: 'str', channel: 'edge' },
      { name: 'transport', wire: 'str', channel: 'edge' },
      { name: 'armorClass', wire: 'str', channel: 'edge' },
    ],
  },
};

/** Build a lifecycle payload from the declared field list — the emitter
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
  const fields = verb === 'spawn' ? kind.spawnFields : verb === 'update' ? kind.updateFields : kind.goneFields;
  const msg: Record<string, unknown> = { type: kind.verbs[verb], [idField]: id };
  for (const f of fields ?? []) {
    // The id field is declared for documentation but already written —
    // skip it or a vals-less emit would overwrite the id with null.
    if (f.name === idField) continue;
    // An emit that forgets a declared field used to sail out as null —
    // the client then diffs forever. Null IS legit when the declaration
    // names an `absent` sentinel or the field is optional on the wire,
    // so only yell for undeclared-as-absent gaps.
    if (!(f.name in vals)) {
      if (f.absent === undefined) {
        warnOnce(`${kind.kind}.${kind.verbs[verb]}:${f.name}`, `[worldModel] ${kind.kind}.${kind.verbs[verb]} emit missing declared field '${f.name}'`);
      }
    } else if (vals[f.name] != null && !wireOk(f.wire, vals[f.name])) {
      warnOnce(`${kind.kind}.${kind.verbs[verb]}:${f.name}!t`, `[worldModel] ${kind.kind}.${kind.verbs[verb]} emit field '${f.name}' wrong type (want ${f.wire})`);
    }
    msg[f.name] = vals[f.name] ?? f.absent ?? null;
  }
  return msg;
}

/** One roster row — id plus each declared roster field in order. Same
 *  contract as verbPayload: the declared field set owns the wire shape. */
export function rosterRow(
  kind: WorldKindDecl,
  idField: string,
  id: number | string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = { [idField]: id };
  for (const f of kind.rosterFields ?? []) {
    if (f.name === idField) continue;
    if (!(f.name in vals)) {
      if (f.absent === undefined) {
        warnOnce(`${kind.kind}.roster:${f.name}`, `[worldModel] ${kind.kind} roster row missing declared field '${f.name}'`);
      }
    } else if (vals[f.name] != null && !wireOk(f.wire, vals[f.name])) {
      warnOnce(`${kind.kind}.roster:${f.name}!t`, `[worldModel] ${kind.kind} roster row field '${f.name}' wrong type (want ${f.wire})`);
    }
    row[f.name] = vals[f.name] ?? f.absent ?? null;
  }
  return row;
}

/** Inverse of verbPayload for the consumer side: copy each declared
 *  field present on an inbound row into a patch — undefined keys mean
 *  "row didn't carry it, keep the stored value". Copying is the whole
 *  point: a declared field a consumer forgot to read can't drift the
 *  replica away from the wire again. Empty-string counts as absent
 *  (wire never carries it meaningfully); 0/false are real values. */
export function rowPatch(fields: KindFieldDecl[], row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const v = row[f.name];
    if (v === undefined || v === null || v === '') continue;
    patch[f.name] = v;
  }
  return patch;
}

/** Spawn-half convenience — most emits only need the spawn verb. */
export function spawnPayload(
  kind: WorldKindDecl,
  id: number | string,
  idField: string,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  return verbPayload(kind, 'spawn', idField, id, vals);
}

/** One-off lifecycle notify payload — same contract as verbPayload but
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
  for (const f of fields ?? []) {
    if (f.name === idField) continue;
    if (!(f.name in vals)) {
      if (f.absent === undefined) {
        warnOnce(`${kind.kind}.${type}:${f.name}`, `[worldModel] ${kind.kind}.${type} emit missing declared field '${f.name}'`);
      }
    } else if (vals[f.name] != null && !wireOk(f.wire, vals[f.name])) {
      warnOnce(`${kind.kind}.${type}:${f.name}!t`, `[worldModel] ${kind.kind}.${type} emit field '${f.name}' wrong type (want ${f.wire})`);
    }
    msg[f.name] = vals[f.name] ?? f.absent ?? null;
  }
  return msg;
}

/** Inbound half of the emit guard: a packet that drops a declared field
 *  warns once at dispatch — same contract as verbPayload's emit-side
 *  warn (absent sentinel or optional = fine). Fields the sender legit
 *  omits (`absent` declared) stay quiet. */
export function checkPacket(
  kind: WorldKindDecl,
  verb: 'spawn' | 'update' | 'gone' | (string & {}),
  msg: Record<string, unknown>,
): void {
  const fields =
    verb === 'spawn' ? kind.spawnFields :
    // flag-style kinds whose update verb IS the roster broadcast check
    // rows against rosterFields — there is no per-row updateFields list.
    verb === 'update' ? (kind.updateFields ?? kind.rosterFields) :
    verb === 'gone' ? kind.goneFields :
    verb === 'roster' ? kind.rosterFields :
    kind.events?.[verb];
  const label = verb in kind.verbs ? (kind.verbs as Record<string, string>)[verb]! : verb;
  // One field-list check for every surface — rows, cross-kind roster
  // containers, and envelopes share the contract: absent-declared fields
  // may be missing, null is the wire's absent sentinel, anything else
  // must satisfy wireOk.
  const checkFields = (fs: KindFieldDecl[] | undefined, m: Record<string, unknown>, tag: string) => {
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
  const check = (m: Record<string, unknown>) => checkFields(fields, m, '');
  // Row-wrapped verbs (tickUpdate's updates[], roster arrays) check each
  // row — the fields live there, not at message level. Roster feeds pick
  // the container for THEIR kind: gameState carries every roster, so a
  // blind first-array pick would check ball rows against player fields.
  const ROSTER_ROWS: Record<string, string> = { ball: 'balls', creature: 'crawlers', flag: 'flags', player: 'players', pickup: 'pickups', deploy: 'deployables' };
  if (verb === 'roster') {
    // A roster feed may carry several kinds (gameState ships them all) —
    // sweep every declared container present, not just the caller's.
    for (const k of Object.values(WORLD_MODEL)) {
      if (!k.rosterFields || k === kind) continue;
      const extra = msg[ROSTER_ROWS[k.kind]!];
      if (Array.isArray(extra)) {
        for (const r of extra) checkFields(k.rosterFields, r as Record<string, unknown>, `${k.kind} `);
      }
    }
    const rows = ROSTER_ROWS[kind.kind] ? msg[ROSTER_ROWS[kind.kind]!] : undefined;
    if (Array.isArray(rows)) { for (const r of rows) check(r as Record<string, unknown>); }
    // The envelope's own fields — the roster containers get row-checked
    // above; this verifies the message-level payload (players[],
    // protocolVersion, map, scores, ...) carries its declared shape.
    if (kind.envelope) checkFields(kind.envelope, msg, 'env:');
    return;
  }
  // Update envelopes (tickUpdate's ack/count keys) wrap the row list —
  // checked before the row branch since updates[] returns early.
  if (verb === 'update' && kind.updateEnvelope) checkFields(kind.updateEnvelope, msg, 'env:');
  const rows = msg.updates ?? msg.balls ?? msg.crawlers ?? msg.flags ?? msg.players;
  if (Array.isArray(rows)) { for (const r of rows) check(r as Record<string, unknown>); return; }
  check(msg);
}

/** Inbound intent declarations — client→server required fields per
 *  ClientMessage union member. Optional union fields are declared with
 *  `absent` for documentation; only a field with NO absent marker warns
 *  when missing, matching the emit-side contract. A hostile or buggy
 *  client that drops a required field warns once at dispatch instead of
 *  the handler reading `undefined.x` five frames later. */
export interface IntentFieldDecl { name: string; wire?: KindFieldDecl['wire']; absent?: unknown }
export const CLIENT_INTENTS: Record<string, IntentFieldDecl[]> = {
  join: [{ name: 'playerId', wire: 'str' }, { name: 'token', wire: 'str', absent: null }, { name: 'room', wire: 'str', absent: null }, { name: 'mode', wire: 'str', absent: null }, { name: 'perk', wire: 'str', absent: null }, { name: 'armorClass', wire: 'str', absent: null }, { name: 'name', wire: 'str', absent: null }, { name: 'map', wire: 'str', absent: null }, { name: 'bots', wire: 'num', absent: null }, { name: 'unlisted', wire: 'bool', absent: null }, { name: 'transport', wire: 'str', absent: null }, { name: 'resumeSeq', wire: 'num', absent: null }],
  position: [{ name: 'position', wire: 'vec3' }, { name: 'rotation', wire: 'rot' }, { name: 'velocity', wire: 'vec3' }, { name: 'seq', wire: 'num', absent: null }, { name: 'inputSeq', wire: 'num', absent: null }, { name: 'ping', wire: 'num', absent: null }],
  teleport: [{ name: 'position', wire: 'vec3' }, { name: 'rotation', wire: 'rot' }, { name: 'velocity', wire: 'vec3' }],
  ping: [{ name: 'timestamp', wire: 'num' }],
  clientStats: [{ name: 'fps', wire: 'num' }, { name: 'jsMs', wire: 'num' }, { name: 'ping', wire: 'num' }, { name: 'loss', wire: 'num' }, { name: 'jitter', wire: 'num' }],
  chat: [{ name: 'text', wire: 'str' }, { name: 'team', wire: 'bool', absent: null }, { name: 'vgs', wire: 'str', absent: null }],
  aoeShot: [{ name: 'position', wire: 'vec3' }, { name: 'weaponType', wire: 'num', absent: null }, { name: 'excludeTargetId', wire: 'str', absent: null }, { name: 'projectileId', wire: 'str', absent: null }, { name: 'airtime', wire: 'num', absent: null }, { name: 'power', wire: 'num', absent: null }, { name: 'directHit', wire: 'bool', absent: null }, { name: 'shotId', wire: 'str', absent: null }],
  shotFired: [{ name: 'weaponType', wire: 'num', absent: null }, { name: 'dir', wire: 'vec3', absent: null }, { name: 'pos', wire: 'vec3', absent: null }, { name: 'shotId', wire: 'str', absent: null }],
  jump: [{ name: 'position', wire: 'vec3' }],
  jetpack: [{ name: 'position', wire: 'vec3' }],
  inputMove: [{ name: 'input', wire: 'obj' }, { name: 'rotation', wire: 'rot' }, { name: 'seq', wire: 'num', absent: null }],
  projectileDestroy: [{ name: 'projectileId', wire: 'str' }, { name: 'shotId', wire: 'str', absent: null }],
  environmentDamage: [{ name: 'amount', wire: 'num' }, { name: 'attacker', wire: 'str', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  heal: [{ name: 'amount', wire: 'num' }, { name: 'claimSeq', wire: 'num', absent: null }],
  creatureHit: [{ name: 'id', wire: 'num' }, { name: 'damage', wire: 'num' }, { name: 'kx', wire: 'num', absent: null }, { name: 'ky', wire: 'num', absent: null }, { name: 'kz', wire: 'num', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  crawlerHit: [{ name: 'id', wire: 'num' }, { name: 'damage', wire: 'num' }, { name: 'kx', wire: 'num', absent: null }, { name: 'ky', wire: 'num', absent: null }, { name: 'kz', wire: 'num', absent: null }, { name: 'claimSeq', wire: 'num', absent: null }],
  deploy: [{ name: 'kind', wire: 'str' }, { name: 'position', wire: 'vec3' }, { name: 'claimSeq', wire: 'num', absent: null }],
  repair: [{ name: 'targetId', wire: 'num' }, { name: 'claimSeq', wire: 'num', absent: null }],
  skillUse: [{ name: 'claimSeq', wire: 'num', absent: null }],
  slam: [{ name: 'position', wire: 'vec3' }, { name: 'claimSeq', wire: 'num', absent: null }],
  respawn: [{ name: 'hold', wire: 'bool', absent: null }],
  throwFlag: [],
  snapshotRequest: [],
  resync: [],
  classUpdate: [{ name: 'armorClass', wire: 'str' }],
  perkUpdate: [{ name: 'perk', wire: 'str' }],
  switchRoom: [{ name: 'room', wire: 'str', absent: null }, { name: 'mode', wire: 'str', absent: null }, { name: 'map', wire: 'str', absent: null }, { name: 'bots', wire: 'num', absent: null }, { name: 'unlisted', wire: 'bool', absent: null }],
};

// Any warn here repeats per packet/emit — a hostile peer or a broken
// emit inside a per-entity loop would flood the log. Throttle per key so
// the signal survives without the flood.
const WARN_ONCE_MS = 5000;
/** Shape check for a declared wire type — presence alone can't catch a
 *  field that arrives as the wrong kind of value. */
function wireOk(wire: KindFieldDecl['wire'], v: unknown): boolean {
  switch (wire) {
    case 'num': return typeof v === 'number' && Number.isFinite(v);
    case 'str': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'arr': return Array.isArray(v);
    case 'obj': return typeof v === 'object' && v !== null;
    case 'vec3': {
      const o = v as { x?: unknown; y?: unknown; z?: unknown } | null;
      return typeof o === 'object' && o !== null &&
        typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number';
    }
    case 'rot': {
      const o = v as { yaw?: unknown; pitch?: unknown } | null;
      return typeof o === 'object' && o !== null &&
        typeof o.yaw === 'number' && typeof o.pitch === 'number';
    }
  }
}

const warnOnceSeen = new Map<string, number>();
function warnOnce(key: string, text: string): void {
  const now = sharedNow();
  const last = warnOnceSeen.get(key);
  if (last !== undefined && now - last < WARN_ONCE_MS) return;
  warnOnceSeen.set(key, now);
  console.warn(text);
}

/** Inbound twin of checkPacket: required intent fields missing from a
 *  client packet warn at dispatch. Message types with no declaration
 *  stay unchecked (e.g. a union member added before its intent lands). */
export function checkIntent(type: string, msg: Record<string, unknown>): void {
  const fields = CLIENT_INTENTS[type];
  if (!fields) return;
  for (const f of fields) {
    if (f.name in msg && f.wire && msg[f.name] != null && !wireOk(f.wire, msg[f.name])) {
      warnOnce(`${type}:${f.name}!t`, `[worldModel] inbound intent ${type} field '${f.name}' wrong type (want ${f.wire})`);
    }
    if (!(f.name in msg) && f.absent === undefined) {
      warnOnce(`${type}:${f.name}`, `[worldModel] inbound intent '${type}' missing required field '${f.name}'`);
    }
  }
}

/** Wire-verb → (kind, verb) index for inbound checking — the dispatcher
 *  looks a message type up here instead of mapping verbs by hand. */
const VERB_INDEX = new Map<string, { kind: WorldKindDecl; verb: string }>();
for (const k of Object.values(WORLD_MODEL)) {
  for (const v of ['spawn', 'update', 'gone', 'roster'] as const) {
    if (k.verbs[v]) VERB_INDEX.set(k.verbs[v]!, { kind: k, verb: v });
  }
  // Event notifies index under their own wire type, not a verb slot.
  for (const t of Object.keys(k.events ?? {})) {
    VERB_INDEX.set(t, { kind: k, verb: t });
  }
}
export function verbForType(type: string): { kind: WorldKindDecl; verb: string } | undefined {
  return VERB_INDEX.get(type);
}

/** The per-id field tuple a hash-miss diff carries for a kind — the
 *  ORDER comes from the declaration, so the server's emit and the
 *  client's diff can never disagree about which slot is which field. */
export function fieldNames(kind: WorldKindDecl): string[] {
  return kind.fields.map((f) => f.name);
}

/** Union of a kind's declared field names across the given slots —
 *  consumers derive "every field this kind can carry" instead of
 *  re-listing them (the client player roster's patch list is exactly
 *  spawn ∪ update ∪ roster — a second hand-written list would drift). */
export function declaredFieldNames(
  kind: WorldKindDecl,
  ...slots: ('fields' | 'spawnFields' | 'updateFields' | 'rosterFields' | 'goneFields')[]
): string[] {
  const out: string[] = [];
  for (const s of slots) {
    for (const f of kind[s] ?? []) {
      if (!out.includes(f.name)) out.push(f.name);
    }
  }
  return out;
}

/** Emit `fields` for every entity in a roster — id first, then each
 *  declared field in declaration order. The tuple's element type is the
 *  declared fields' types; callers cast to their wire slot. */
export function kindFields(kind: WorldKindDecl, roster: Iterable<{ id: number }>): unknown[][] {
  const decls = kind.fields;
  const out: unknown[][] = [];
  for (const e of roster) {
    const r = e as unknown as Record<string, unknown>;
    out.push([e.id, ...decls.map((d) => r[d.name] ?? d.absent ?? null)]);
  }
  return out;
}

/** Client half of the hash-miss diff: compare the server's emitted field
 *  tuples against the local replica map by DECLARED field name — the
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
  if (!serverFields) return { diffs, keys };
  const seen = new Set<number>();
  for (const row of serverFields) {
    const id = row[0] as number;
    seen.add(id);
    const l = local.get(id);
    if (!l) { diffs.push(`#${id}:missing`); keys.add(`${id}:missing`); continue; }
    for (let i = 0; i < kind.fields.length; i++) {
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
