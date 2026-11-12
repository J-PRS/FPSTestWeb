import { describe, it, expect } from 'bun:test';
import { CLIENT_INTENTS, type IntentFieldDecl } from '../../shared/worldModel.ts';
import { WIRE } from '../src/wire.ts';
import type { ClientMessage } from '../../shared/protocol.ts';

/**
 * Inbound consumer conformance — the mirror of wireProducers.test.ts.
 * WIRE validators rebuild `data` field-by-field, so a field the CLIENT_
 * INTENTS contract declares but the validator forgets to pick up is
 * silently stripped before the handler ever sees it — the dead-`rttMs`
 * class in reverse. This pins both directions of the contract:
 *  1. every ClientMessage type has an intents entry (or checkIntent is
 *     silently blind for that type), and
 *  2. every declared field survives validation into the handler payload.
 */

const ALL_CLIENT_TYPES = [
  'aoeShot', 'chat', 'classUpdate', 'clientStats', 'crawlerHit', 'creatureHit',
  'deploy', 'environmentDamage', 'heal', 'held', 'inputMove', 'jetpack', 'join', 'jump',
  'perkUpdate', 'ping', 'pong', 'position', 'projectileDestroy', 'ready', 'repair', 'respawn',
  'resync', 'shotFired', 'skillUse', 'slam', 'snapshotRequest', 'switchRoom',
  'teleport', 'throwFlag', 'tickNack',
] as const satisfies readonly ClientMessage['type'][];

// Enum-like fields reject a generic 'sentinel' string — pin valid values
// where the validator constrains the domain.
const FIELD_SENTINEL: Record<string, unknown> = {
  armorClass: 'medium',
  perk: 'armored',
  kind: 'turret',
  input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0 },
  room: 'felt-canary-room',
};

function sentinel(f: IntentFieldDecl): unknown {
  if (f.name in FIELD_SENTINEL) {return FIELD_SENTINEL[f.name];}
  switch (f.wire) {
    case 'num': { return 7;
    }
    case 'str': { return 'sentinel';
    }
    case 'bool': { return true;
    }
    case 'arr': { return [1];
    }
    case 'obj': { return { sentinel: 1 };
    }
    case 'vec3': { return { x: 1, y: 2, z: 3 };
    }
    case 'rot': { return { yaw: 1, pitch: 0 };
    }
    default: { return 'sentinel';
    }
  }
}

describe('intent consumer conformance', () => {
  it('every ClientMessage type declares its intent fields — no silent unchecked type', () => {
    for (const t of ALL_CLIENT_TYPES) {
      expect(CLIENT_INTENTS[t], `${t} has no CLIENT_INTENTS entry — checkIntent is blind for it`).toBeDefined();
    }
    // Reverse: no intent declaration for a type that isn't on the wire.
    const known = new Set<string>(ALL_CLIENT_TYPES);
    for (const t of Object.keys(CLIENT_INTENTS)) {
      expect(known.has(t), `CLIENT_INTENTS.${t} is not a ClientMessage type`).toBe(true);
    }
  });

  it('every declared field survives the validator — nothing is stripped between decode and handler', () => {
    const stripped: string[] = [];
    for (const t of ALL_CLIENT_TYPES) {
      const decls = CLIENT_INTENTS[t] ?? [];
      if (decls.length === 0) {continue;}
      const entry = WIRE[t as ClientMessage['type']];
      if (!entry) {continue;} // join/switchRoom never reach room dispatch
      const msg: Record<string, unknown> = { type: t };
      for (const f of decls) {msg[f.name] = sentinel(f);}
      const res = entry.validate(msg as never);
      if (!res.success) {
        stripped.push(`${t} (rejected: ${'error' in res ? res.error : '?'})`);
        continue;
      }
      const data = res.data as Record<string, unknown>;
      for (const f of decls) {
        if (!(f.name in data)) {stripped.push(`${t}.${f.name}`);}
      }
    }
    expect(stripped).toEqual([]);
  });
});
