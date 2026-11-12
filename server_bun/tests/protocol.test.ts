import { describe, it, expect } from 'bun:test';
import { PROTOCOL_VERSION, type ClientMessage } from '../../shared/protocol.ts';
import { WIRE } from '../src/wire.ts';

// The wire contract drift tripwire. ClientMessage is a TS union — it
// evaporates at runtime, so nothing stops a new message type landing in
// the union without a WIRE entry: every such packet then falls into the
// 'unhandled' heartbeat and is silently dropped for every player. The
// satisfies + Exclude pair below fails tsc the moment the union grows
// without this list; the runtime asserts then pin what each entry owes.

const ALL_CLIENT_TYPES = [
  'aoeShot', 'chat', 'classUpdate', 'clientStats', 'crawlerHit', 'creatureHit',
  'deploy', 'environmentDamage', 'heal', 'held', 'inputMove', 'jetpack', 'join', 'jump',
  'perkUpdate', 'ping', 'pong', 'position', 'projectileDestroy', 'ready', 'repair', 'respawn',
  'resync', 'shotFired', 'skillUse', 'slam', 'snapshotRequest', 'switchRoom',
  'teleport', 'throwFlag', 'tickNack',
] as const satisfies readonly ClientMessage['type'][];

type Missing = Exclude<ClientMessage['type'], typeof ALL_CLIENT_TYPES[number]>;
const _exhaustive: Missing extends never ? true : never = true;
void _exhaustive;

describe('protocol wire contract', () => {
  it('every ClientMessage type resolves to a WIRE entry', () => {
    for (const t of ALL_CLIENT_TYPES) {
      const entry = WIRE[t];
      expect(entry, `${t} has no WIRE entry`).toBeDefined();
      expect(typeof entry!.validate, `${t} has no validator`).toBe('function');
    }
  });

  it('every WIRE entry carries a room handler — switchRoom is the documented exception', () => {
    // switchRoom validates here but GameServer intercepts before room
    // dispatch, so it carries no handle (see wire.ts head). join's
    // handler only heals the seated-socket retry (resends worldstate).
    for (const t of ALL_CLIENT_TYPES) {
      if (t === 'switchRoom') {continue;}
      expect(typeof WIRE[t]!.handle, `${t} validates but has no room handler`).toBe('function');
    }
    expect(WIRE.switchRoom!.handle).toBeUndefined();
  });

  it('no WIRE entries exist for types outside the union', () => {
    const known = new Set<string>(ALL_CLIENT_TYPES);
    for (const key of Object.keys(WIRE)) {
      expect(known.has(key), `WIRE.${key} is not a ClientMessage type`).toBe(true);
    }
  });

  it('protocol version is a positive integer — mismatch warns+retries client-side', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
