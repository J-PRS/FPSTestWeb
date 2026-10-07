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
  verbs: { spawn: string; update: string; gone: string };
  /** Lifecycle/mirrored fields a replica MUST agree on — hashed + diffed. */
  fields: KindFieldDecl[];
  /** Streamed motion fields — the shared sim replays them, so they are
   *  presence-checked only (a stranded replica), never value-diffed. */
  simFields: KindFieldDecl[];
}

export const WORLD_MODEL: Record<string, WorldKindDecl> = {
  ball: {
    kind: 'ball',
    verbs: { spawn: 'ballSpawn', update: 'ballSegment', gone: 'ballDie' },
    fields: [
      { name: 'variant', channel: 'edge' },
      { name: 'enraged', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
    ],
    simFields: [
      { name: 'position', channel: 'sim' },
      { name: 'velocity', channel: 'sim' },
    ],
  },
  creature: {
    kind: 'creature',
    verbs: { spawn: 'crawlSpawn', update: 'crawlEvt', gone: 'crawlDie' },
    fields: [
      { name: 'species', channel: 'edge' },
      { name: 'state', channel: 'edge' },
      { name: 'uber', channel: 'edge' },
      { name: 'targetId', channel: 'edge' },
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
    simFields: [
      { name: 'pos', channel: 'sim' },
    ],
  },
};

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
