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

export interface KindFieldDecl {
  /** Field name on the sim's entity record (server) and the client replica. */
  name: string;
  channel: SyncChannel;
  /** Value emitted when the field is absent — the wire's sentinel for
   *  'not set' (deploy teams diff '' server-side, never null). */
  absent?: unknown;
}

export interface WorldKindDecl {
  /** Wire verb prefix: ball => ballSpawn / ballSegment / ballDie. */
  kind: string;
  verbs: { spawn: string; update: string; gone: string; roster?: string };
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
  /** Streamed motion fields — the shared sim replays them, so they are
   *  presence-checked only (a stranded replica), never value-diffed. */
  simFields: KindFieldDecl[];
}

export const WORLD_MODEL: Record<string, WorldKindDecl> = {
  ball: {
    kind: 'ball',
    verbs: { spawn: 'ballSpawn', update: 'ballSegment', gone: 'ballDie', roster: 'ballRoster' },
    fields: [
      { name: 'variant', channel: 'edge' },
      { name: 'enraged', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'variant', channel: 'edge' },
      { name: 'colorIdx', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    goneFields: [
      { name: 'position', channel: 'sim' },
      { name: 'by', channel: 'edge' },
    ],
    // ballSegment rides a packed binary frame (wire.ts), not JSON — the
    // list still declares the shape once so the conformance test pins it.
    updateFields: [
      { name: 'kind', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'enraged', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 'et', channel: 'edge' },
      { name: 'slowT', channel: 'edge' },
      { name: 'damp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    rosterFields: [
      { name: 'variant', channel: 'edge' },
      { name: 'colorIdx', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'enraged', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    simFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
    ],
  },
  creature: {
    kind: 'creature',
    verbs: { spawn: 'crawlSpawn', update: 'crawlEvt', gone: 'crawlDie', roster: 'crawlRoster' },
    fields: [
      { name: 'species', channel: 'edge' },
      { name: 'state', channel: 'edge' },
      { name: 'uber', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'position', channel: 'sim' },
      { name: 'seed', channel: 'edge' },
      { name: 'uber', channel: 'edge' },
      { name: 'species', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    goneFields: [
      { name: 'position', channel: 'sim' },
      { name: 'by', channel: 'edge' },
    ],
    updateFields: [
      { name: 'kind', channel: 'edge' },
      { name: 'sk', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    rosterFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'uber', channel: 'edge' },
      { name: 'seed', channel: 'edge' },
      { name: 'species', channel: 'edge' },
      { name: 'state', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
      { name: 'tp', channel: 'edge' },
      { name: 't', channel: 'sim' },
    ],
    simFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
    ],
  },
  deploy: {
    kind: 'deploy',
    verbs: { spawn: 'deploySpawn', update: 'deployHp', gone: 'deployGone' },
    fields: [
      { name: 'kind', channel: 'edge' },
      { name: 'owner', channel: 'edge' },
      { name: 'team', channel: 'edge', absent: '' },
    ],
    spawnFields: [
      { name: 'owner', channel: 'edge' },
      { name: 'kind', channel: 'edge' },
      { name: 'pos', channel: 'sim' },
      { name: 'team', channel: 'edge' },
    ],
    updateFields: [
      { name: 'hp', channel: 'echo' },
      { name: 'armor', channel: 'echo' },
      { name: 'src', channel: 'echo' },
    ],
    goneFields: [],
    // deployDown/deployUp are lifecycle notifies — a wreck flips DOWN
    // and back UP without leaving the roster.
    events: {
      deployDown: [
        { name: 'kind', channel: 'edge' },
        { name: 'team', channel: 'edge', absent: null },
        { name: 'respawnS', channel: 'edge' },
      ],
      deployUp: [],
    },
    simFields: [
      { name: 'pos', channel: 'sim' },
      { name: 'hp', channel: 'echo' },
    ],
  },
  flag: {
    kind: 'flag',
    verbs: { spawn: 'flagSpawn', update: 'flagUpdate', gone: 'flagGone' },
    fields: [
      { name: 'state', channel: 'edge' },
      { name: 'carrier', channel: 'edge' },
    ],
    rosterFields: [
      // The flag's row key is its team — rosterRow writes it under the
      // idField ('team'), so it does not repeat here.
      { name: 'pos', channel: 'sim' },
      { name: 'home', channel: 'edge' },
      { name: 'state', channel: 'edge' },
      { name: 'carrier', channel: 'edge' },
    ],
    simFields: [
      { name: 'pos', channel: 'sim' },
    ],
  },
  pickup: {
    kind: 'pickup',
    verbs: { spawn: 'pickupSpawn', update: 'pickupKnock', gone: 'pickupGone' },
    fields: [
      { name: 'kind', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'pos', channel: 'sim' },
      { name: 'kind', channel: 'edge' },
    ],
    goneFields: [
      { name: 'by', channel: 'edge' },
    ],
    simFields: [
      { name: 'pos', channel: 'sim' },
    ],
  },
  projectile: {
    kind: 'projectile',
    verbs: { spawn: 'projectileCreated', update: 'projectileUpdate', gone: 'projectileDestroyed' },
    fields: [
      { name: 'weaponType', channel: 'edge' },
      { name: 'ownerId', channel: 'edge' },
    ],
    spawnFields: [
      { name: 'projectileId', channel: 'edge' },
      { name: 'ownerId', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'weaponType', channel: 'edge' },
      { name: 'shotId', channel: 'echo' },
      { name: 'pellet', channel: 'echo' },
    ],
    goneFields: [],
    simFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
    ],
  },
  // The player lane: join announce / leave / gameState roster rows / the
  // per-tick record. Players are the only client-owned kind — the server
  // relays their claimed state rather than simming it, so their verbs
  // carry claimed values instead of sim-derived ones.
  player: {
    kind: 'player',
    verbs: { spawn: 'playerJoined', update: 'tickUpdate', gone: 'playerLeft', roster: 'gameState' },
    fields: [
      { name: 'internalId', channel: 'edge' },
      { name: 'health', channel: 'sim' },
      { name: 'isDead', channel: 'edge' },
      { name: 'team', channel: 'edge' },
    ],
    // playerJoined announce — id rides the 'playerId' key, not 'id'.
    spawnFields: [
      { name: 'name', channel: 'edge' },
      { name: 'internalId', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'rotation', channel: 'sim' },
      { name: 'team', channel: 'edge' },
      { name: 'transport', channel: 'edge' },
      { name: 'armorClass', channel: 'edge' },
      { name: 'health', channel: 'sim' },
      { name: 'isDead', channel: 'edge' },
    ],
    goneFields: [],
    // tickUpdate record — id rides 'playerId'; the binary tick frame
    // packs the same fields.
    updateFields: [
      { name: 'position', channel: 'sim' },
      { name: 'rotation', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'health', channel: 'sim' },
      { name: 'isDead', channel: 'edge' },
      // Wire-optional below — the binary frame and old JSON senders omit
      // them when unset; `absent` marks omission as legal, not drift.
      { name: 'ping', channel: 'sim', absent: null },
      { name: 'ski', channel: 'sim', absent: null },
      { name: 'status', channel: 'edge', absent: null },
      { name: 'sheep', channel: 'sim', absent: null },
    ],
    // gameState player row — id rides 'id' here (GameStatePlayer.id),
    // unlike the verbs' playerId.
    rosterFields: [
      { name: 'name', channel: 'edge' },
      { name: 'internalId', channel: 'edge' },
      { name: 'position', channel: 'sim' },
      { name: 'rotation', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
      { name: 'isDead', channel: 'edge' },
      { name: 'health', channel: 'sim' },
      { name: 'status', channel: 'edge' },
      { name: 'team', channel: 'edge' },
      { name: 'transport', channel: 'edge' },
      { name: 'armorClass', channel: 'edge' },
    ],
    simFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
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
    if (!(f.name in vals) && f.absent === undefined) {
      console.warn(`[worldModel] ${kind.kind}.${kind.verbs[verb]} emit missing declared field '${f.name}'`);
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
    if (!(f.name in vals) && f.absent === undefined) {
      console.warn(`[worldModel] ${kind.kind} roster row missing declared field '${f.name}'`);
    }
    row[f.name] = vals[f.name] ?? f.absent ?? null;
  }
  return row;
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
    if (!(f.name in vals) && f.absent === undefined) {
      console.warn(`[worldModel] ${kind.kind}.${type} emit missing declared field '${f.name}'`);
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
  const check = (m: Record<string, unknown>) => {
    for (const f of fields ?? []) {
      if (!(f.name in m) && f.absent === undefined) {
        console.warn(`[worldModel] inbound ${kind.kind}.${label} missing declared field '${f.name}'`);
      }
    }
  };
  // Row-wrapped verbs (tickUpdate's updates[], roster arrays) check each
  // row — the fields live there, not at message level. Roster feeds pick
  // the container for THEIR kind: gameState carries every roster, so a
  // blind first-array pick would check ball rows against player fields.
  const ROSTER_ROWS: Record<string, string> = { ball: 'balls', creature: 'crawlers', flag: 'flags', player: 'players' };
  const rows = verb === 'roster' && ROSTER_ROWS[kind.kind]
    ? msg[ROSTER_ROWS[kind.kind]!]
    : msg.updates ?? msg.balls ?? msg.crawlers ?? msg.flags ?? msg.players;
  if (Array.isArray(rows)) { for (const r of rows) check(r as Record<string, unknown>); return; }
  check(msg);
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
