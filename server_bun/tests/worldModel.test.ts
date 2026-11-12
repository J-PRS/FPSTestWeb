import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORLD_MODEL, CLIENT_INTENTS, declaredFieldNames } from '../../shared/worldModel.ts';
import { encodeBallSegment, decodeBallSegment, encodeTickPlayerV3, encodeTickFrame, decodeTickFrame, encodePosition, decodePosition, WIRE_TICK_V3 } from '../../shared/wire.ts';
import type { WireTickPlayer } from '../../shared/wire.ts';

// World-model <-> wire-union drift tripwire. The emits generate payloads
// from the declared field lists, but the `as ServerMessage` casts mean
// nothing checks the declarations against the union they land on — a
// renamed field or a deleted union member would sail through tsc and
// only surface as a client reading `undefined`. protocol.ts members are
// single-line object literals, so a line scan pins each verb's fields.

const PROTOCOL = readFileSync(
  resolve(import.meta.dir, '../../shared/protocol.ts'), 'utf8');

function unionLine(verb: string): string | null {
  // Members are `| { type: 'v'; ... }` and may wrap lines (crawlEvt's sk
  // comment does) — capture to the next member, not to end-of-line.
  const re = new RegExp(`type: '${verb}'[\\s\\S]*?(?=\\n\\s*\\|)`);
  const m = PROTOCOL.match(re);
  return m ? m[0] : null;
}

// Roster rows can live inside a named interface (gameState's players are
// GameStatePlayer[]) — resolve `interface X { ... }` bodies the same way
// so a field-name reference can't hide drift.
const INTERFACES = new Map<string, string>();
for (const m of PROTOCOL.matchAll(/interface (\w+) \{([\s\S]*?)\n\}/g)) {
  INTERFACES.set(m[1]!, m[2]!);
}
const hasField = (text: string, name: string) =>
  text.includes(`${name}:`) || text.includes(`${name}?:`);

// A verb member can point at a named row type (`updates: TickUpdatePlayer[]`)
// — expand the search text to include the bodies of any interfaces it names.
function withInterfaces(member: string): string {
  let text = member;
  for (const m of member.matchAll(/(\w+)\[\]/g)) {
    const body = INTERFACES.get(m[1]!);
    if (body) {text += `\n${body}`;}
  }
  return text;
}

const VERB_LISTS: [('spawn' | 'update' | 'gone' | 'roster'), 'spawnFields' | 'updateFields' | 'goneFields' | 'rosterFields'][] = [
  ['spawn', 'spawnFields'],
  ['update', 'updateFields'],
  ['gone', 'goneFields'],
  // flag's update verb IS its roster feed — no separate roster verb.
  ['roster', 'rosterFields'],
];

describe('world model <-> protocol conformance', () => {
  for (const kind of Object.values(WORLD_MODEL)) {
    for (const [verbKey, listKey] of VERB_LISTS) {
      const fields = kind[listKey];
      if (!fields || !kind.verbs[verbKey]) {continue;}
      const verb = kind.verbs[verbKey]!;
      it(`${kind.kind}.${verb} exists in the ServerMessage union with every declared field`, () => {
        const line = unionLine(verb);
        expect(line, `${verb} not found in protocol.ts`).not.toBeNull();
        const text = withInterfaces(line!);
        for (const f of fields!) {
          // Union members mark wire-optional fields as `name?:`.
          const present = hasField(text, f.name);
          expect(present, `${verb} union member is missing declared field '${f.name}'`).toBe(true);
        }
      });
    }
    for (const [type, evFields] of Object.entries(kind.events ?? {})) {
      it(`${kind.kind}.${type} event exists in the ServerMessage union with every declared field`, () => {
        const line = unionLine(type);
        expect(line, `${type} not found in protocol.ts`).not.toBeNull();
        const text = withInterfaces(line!);
        for (const f of evFields!) {
          expect(hasField(text, f.name), `${type} union member is missing declared field '${f.name}'`).toBe(true);
        }
      });
    }
    if (kind.rosterFields) {
      it(`${kind.kind} roster row fields exist in a protocol member`, () => {
        // Roster rows live inside a roster verb (ballRoster/crawlRoster/
        // flagUpdate) — find the union line whose row shape carries every
        // declared roster field.
        const names = kind.rosterFields!.map((f) => f.name);
        // Check inline union members AND named interface bodies.
        const chunks = [
          ...PROTOCOL.split('\n'),
          ...INTERFACES.values(),
        ];
        const hit = chunks.some((l) => names.every((n) => hasField(l, n)));
        expect(hit, `${kind.kind}: no union member/interface carries roster fields ${names.join(' ')}`).toBe(true);
      });
    }
  }

  it('ballSegment binary round-trip carries every declared update field', () => {
    // The frame is hand-packed; this pins the declared field list to what
    // actually survives encode/decode.
    const seg = {
      id: 7, kind: 'bounce', position: { x: 1, y: 2, z: 3 },
      velocity: { x: 4, y: 5, z: 6 }, enraged: true, targetId: 'p9',
      tp: { x: 7, y: 8, z: 9 }, et: 1.5, slowT: 0.5, damp: true, t: 12.25,
    };
    const back = decodeBallSegment(encodeBallSegment(seg));
    expect(back).not.toBeNull();
    for (const f of WORLD_MODEL.ball!.updateFields!) {
      expect(back as unknown as Record<string, unknown>, `decoded segment missing '${f.name}'`)
        .toHaveProperty(f.name);
    }
  });

  it('every ClientMessage union member has a declared intent — and its fields exist', () => {
    // Slice just the ClientMessage union, split members on `| { type:` —
    // members span lines, so a line scan can't isolate them.
    const start = PROTOCOL.indexOf('export type ClientMessage');
    const end = PROTOCOL.indexOf('export interface TickUpdatePlayer');
    const union = PROTOCOL.slice(start, end);
    const members = union.split(/\| \{ type: '/).slice(1);
    for (const m of members) {
      const type = m.slice(0, m.indexOf("'"));
      const fields = CLIENT_INTENTS[type];
      expect(fields, `ClientMessage '${type}' has no CLIENT_INTENTS declaration`).toBeDefined();
      for (const f of fields ?? []) {
        expect(m.includes(`${f.name}:`) || m.includes(`${f.name}?:`), `'${type}' union member carries no '${f.name}' field — declaration drifted`).toBe(true);
      }
    }
    // And no declared intent names a type the union dropped.
    const types = new Set(members.map((m) => m.slice(0, m.indexOf("'"))));
    for (const t of Object.keys(CLIENT_INTENTS)) {
      expect(types.has(t), `CLIENT_INTENTS declares '${t}' which no ClientMessage member carries`).toBe(true);
    }
  });

  it('every declared verb and event type exists on the ServerMessage union', () => {
    // A declared verb nothing emits is worse than none — it reads as a
    // wire surface that doesn't exist. Pin declarations to union members.
    const sStart = PROTOCOL.indexOf('export type ServerMessage');
    const union = PROTOCOL.slice(sStart);
    for (const kind of Object.values(WORLD_MODEL)) {
      const verbs = [kind.verbs.spawn, kind.verbs.update, kind.verbs.gone, kind.verbs.roster, ...Object.keys(kind.events ?? {})];
      for (const v of verbs) {
        if (!v) {continue;}
        // indexOf, not includes: the prefer-set-has autofix rewrites
        // includes→new Set(str).has — a CHAR-set check that always fails.
        // This exact lint --fix revert has killed the tripwire ~10 times.
        expect(union.indexOf(`type: '${v}'`) >= 0, `${kind.kind} declares '${v}' — no ServerMessage member carries it`).toBe(true);
      }
    }
  });

  it('binary position report round-trips every declared position-intent field', () => {
    // WIRE_POSITION is the binary lane of the 'position' intent — the
    // declared field list is what the frame must actually carry.
    const back = decodePosition(encodePosition(
      { x: 10.5, y: 2.25, z: -4.5 }, { yaw: 1.2, pitch: -0.4 },
      { x: 3.1, y: 0.4, z: -8.2 }, 7, 42, 11));
    expect(back).not.toBeNull();
    for (const f of CLIENT_INTENTS['position']!) {
      expect(back as unknown as Record<string, unknown>, `decoded position frame missing '${f.name}'`)
        .toHaveProperty(f.name);
    }
  });

  it('only edge-channel fields sit on the hashed fields list', () => {
    // replicaHash walks kind.fields verbatim — a 'sim' field (streamed
    // motion, always up to a frame stale) or 'echo' field (server-owned,
    // always up to an echo-interval stale) hashed at exact granularity
    // is the phantom-desync class FIELD_CHANNELS warns about.
    // Player is exempt — it hashes through computeStateHash's own
    // channel-aware quantizer, not replicaHash.
    for (const kind of Object.values(WORLD_MODEL)) {
      if (kind.kind === 'player') {continue;}
      for (const f of kind.fields ?? []) {
        expect(f.channel === 'edge', `${kind.kind}.fields '${f.name}' is ${f.channel}-channel but rides the hash`).toBe(true);
      }
    }
  });

  it('tick player record round-trips every declared update field', () => {
    // Same pin for the binary tick frame — the declared updateFields are
    // the field list the hand-packed record must actually carry.
    const p: WireTickPlayer = {
      playerId: 'p1', position: { x: 10.5, y: 2.25, z: -4.5 },
      rotation: { yaw: 1.2, pitch: -0.4 }, velocity: { x: 3.1, y: 0.4, z: -8.2 },
      health: 175, isDead: true, ping: 42, ski: 1, status: 0x10, sheep: 55,
    };
    const frame = encodeTickFrame(0, 1, 0, [encodeTickPlayerV3(7, p)], WIRE_TICK_V3);
    const back = decodeTickFrame(frame);
    expect(back).not.toBeNull();
    const u = back!.updates[0]!;
    expect(u.playerId).toBe(''); // wireId unbound without a roster — the record carries the field, not the lookup
    for (const f of WORLD_MODEL.player!.updateFields!) {
      expect(u as unknown as Record<string, unknown>, `decoded tick record missing '${f.name}'`)
        .toHaveProperty(f.name);
    }
  });

  it('tick player record survives coordinates past the old i16 bound', () => {
    // i16×0.04 saturated at ±1310m — a skier past that edge clamped on
    // the wire and every client read them parked at 1310.7 while the sim
    // moved on (the dunes z-freeze desync). i32 keeps 4cm precision and
    // moves the bound out of reach of any real map.
    const p: WireTickPlayer = {
      playerId: 'p1', position: { x: 2500.4, y: -1600.2, z: 4095.9 },
      rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      health: 100, isDead: false, ski: 0,
    };
    const back = decodeTickFrame(encodeTickFrame(0, 1, 0, [encodeTickPlayerV3(7, p)], WIRE_TICK_V3));
    const u = back!.updates[0]!;
    expect(u.position.x).toBeCloseTo(2500.4, 1);
    expect(u.position.y).toBeCloseTo(-1600.2, 1);
    expect(u.position.z).toBeCloseTo(4095.9, 1);
  });

  it('player roster field union covers every RemotePlayerState patch slot', () => {
    // The client derives its roster patch list from this union — a field
    // declared on one verb but missing the union would silently never
    // patch through. Pin the full expected set.
    expect(new Set(declaredFieldNames(WORLD_MODEL.player!, 'spawnFields', 'updateFields', 'rosterFields')))
      .toEqual(new Set([
        'internalId', 'name', 'position', 'rotation', 'velocity', 'isDead',
        'health', 'ping', 'ski', 'jet', 'status', 'team', 'transport', 'armorClass', 'sheep', 'held',
        'weapon', 'stale',
      ]));
  });

  it('GameStatePlayer interface keys match the declared roster row', () => {
    // The row type is hand-written next to the generated emit — a field
    // added on either side drifts silently. Pin the source-level match.
    const body = PROTOCOL.match(/export interface GameStatePlayer \{([^}]*)\}/)![1]!;
    const keys = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    const declared = new Set(['id', ...declaredFieldNames(WORLD_MODEL.player!, 'rosterFields')]);
    expect(new Set(keys)).toEqual(declared);
  });

  it('gameState inline roster rows match each kind\'s declared row', () => {
    // flags/pickups/deployables ride gameState as inline anonymous row
    // types — same drift surface as GameStatePlayer, same pin.
    const cases: [string, string, string][] = [
      // [container key, idField, kind]
      ['flags', 'team', 'flag'],
      ['pickups', 'id', 'pickup'],
      ['deployables', 'id', 'deploy'],
    ];
    for (const [container, idField, kind] of cases) {
      const inline = PROTOCOL.match(new RegExp(`${container}\\?:\\s*\\{([^}]*)\\}\\[\\]`))![1]!;
      const keys = new Set([...inline.matchAll(/(\w+)\??:/g)].map((m) => m[1]));
      const declared = new Set([idField, ...declaredFieldNames(WORLD_MODEL[kind]!, 'rosterFields')]);
      expect(keys, `${container} row keys drifted from ${kind}.rosterFields`).toEqual(declared);
    }
  });

  it('SnapshotPlayer keys stay inside the declared roster row', () => {
    // The debug feed's row is a subset of the roster row plus kill stats —
    // a key it carries that the model doesn't declare can't come from
    // live state. Pin the subset relation (kills/deaths are the extras).
    const body = PROTOCOL.match(/export interface SnapshotPlayer \{([^}]*)\}/)![1]!;
    const keys = new Set([...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!));
    const declared = new Set(['id', 'kills', 'deaths',
      ...declaredFieldNames(WORLD_MODEL.player!, 'rosterFields')]);
    for (const k of keys) {
      expect(declared.has(k), `SnapshotPlayer key '${k}' has no declared field source`).toBe(true);
    }
  });

  it('RemotePlayerState keys stay inside the declared field union', () => {
    // The replica record is the landing zone for roster/update patches —
    // a key there with no declared field can never be written by wire
    // data (dead slot); a declared field with no key can never land.
    const nm = readFileSync(
      resolve(import.meta.dir, '../../client/src/networking/NetworkManager.ts'), 'utf8');
    const body = nm.match(/export interface RemotePlayerState \{([\s\S]*?)\n\}/)![1]!;
    const keys = new Set([...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]));
    // 'id' keys the replica; 'posAt' is client-local metadata (drift
    // diagnostics stamp it locally — never off the wire, by design).
    const declared = new Set(['id', 'posAt', ...declaredFieldNames(WORLD_MODEL.player!, 'spawnFields', 'updateFields', 'rosterFields')]);
    expect(keys).toEqual(declared);
  });
});
