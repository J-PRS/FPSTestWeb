import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORLD_MODEL } from '../../shared/worldModel.ts';
import { encodeBallSegment, decodeBallSegment, encodeTickPlayerV3, encodeTickFrame, decodeTickFrame, WIRE_TICK_V3 } from '../../shared/wire.ts';
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
    if (body) text += `\n${body}`;
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
      if (!fields || !kind.verbs[verbKey]) continue;
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

  it('simFields stays a subset of the declared field lists', () => {
    // simFields names which declared fields drive the shared sim — a
    // name that isn't declared anywhere is dead data nobody verifies.
    for (const kind of Object.values(WORLD_MODEL)) {
      const declared = new Set([
        ...(kind.fields ?? []), ...(kind.spawnFields ?? []),
        ...(kind.updateFields ?? []), ...(kind.goneFields ?? []),
        ...(kind.rosterFields ?? []),
      ].map((f) => f.name));
      for (const f of kind.simFields ?? []) {
        expect(declared.has(f.name), `${kind.kind}.simFields '${f.name}' isn't declared on any wire list`).toBe(true);
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
});
