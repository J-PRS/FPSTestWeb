import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORLD_MODEL } from '../../shared/worldModel.ts';

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

const VERB_LISTS: ['spawn' | 'update' | 'gone', 'spawnFields' | 'updateFields' | 'goneFields' | 'rosterFields'][] = [
  ['spawn', 'spawnFields'],
  ['update', 'updateFields'],
  ['gone', 'goneFields'],
];

describe('world model <-> protocol conformance', () => {
  for (const kind of Object.values(WORLD_MODEL)) {
    for (const [verbKey, listKey] of VERB_LISTS) {
      const fields = kind[listKey];
      if (!fields) continue;
      const verb = kind.verbs[verbKey];
      it(`${kind.kind}.${verb} exists in the ServerMessage union with every declared field`, () => {
        const line = unionLine(verb);
        expect(line, `${verb} not found in protocol.ts`).not.toBeNull();
        for (const f of fields!) {
          // Union members mark wire-optional fields as `name?:`.
          const present = line!.includes(`${f.name}:`) || line!.includes(`${f.name}?:`);
          expect(present, `${verb} union member is missing declared field '${f.name}'`).toBe(true);
        }
      });
    }
    if (kind.rosterFields) {
      it(`${kind.kind} roster row fields exist in a protocol member`, () => {
        // Roster rows live inside a roster verb (ballRoster/crawlRoster/
        // flagUpdate) — find the union line whose row shape carries every
        // declared roster field.
        const names = kind.rosterFields!.map((f) => f.name);
        const lines = PROTOCOL.split('\n');
        const has = (l: string, n: string) => l.includes(`${n}:`) || l.includes(`${n}?:`);
        const hit = lines.some((l) => names.every((n) => has(l, n)));
        expect(hit, `${kind.kind}: no union member carries roster fields ${names.join(' ')}`).toBe(true);
      });
    }
  }
});
