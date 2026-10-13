/**
 * Wire-validation contract: every ClientMessage type must have a
 * validator (a missing one reads as "Unknown message type" and silently
 * kills the verb on the wire), and validators must preserve optional
 * fields the handlers consume (a stripped field silently degrades a
 * feature — e.g. chat.team dropping made team chat go global).
 */
import { describe, test, expect } from 'bun:test';
import { validateMessage } from '../src/wire.ts';

const VALID_BODIES: Record<string, Record<string, unknown>> = {
  position: { position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0.5, pitch: -0.1 }, velocity: { x: 0, y: 0, z: 0 }, seq: 7, inputSeq: 6, ping: 40 },
  teleport: { position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 } },
  ping: { timestamp: 1234 },
  chat: { text: 'hello', team: true },
  aoeShot: { position: { x: 1, y: 2, z: 3 }, weaponType: 2, excludeTargetId: 'p2', projectileId: 'proj_2', airtime: 0.8, power: 1, directHit: true },
  shotFired: { weaponType: 3, dir: { x: 1, y: 0, z: 0 } },
  jump: { position: { x: 0, y: 60, z: 0 } },
  jetpack: { position: { x: 0, y: 60, z: 0 } },
  inputMove: { seq: 9, input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 1, status: 2 }, rotation: { yaw: 0, pitch: 0 } },
  projectileDestroy: { projectileId: 'proj_9' },
  environmentDamage: { amount: 15 },
  heal: { amount: 20 },
  creatureHit: { id: 3, damage: 25, kx: 0, ky: 0.5, kz: 0.86 },
  crawlerHit: { id: 7, damage: 20, kx: 0, ky: 0, kz: 1 },
  deploy: { kind: 'turret', position: { x: 0, y: 60, z: 0 } },
  snapshotRequest: {},
  classUpdate: { armorClass: 'heavy' },
  perkUpdate: { perk: 'regenerator' },
  switchRoom: { room: 'duel', mode: 'dm', map: 'arena', bots: 4 },
};

describe('validateMessage coverage', () => {
  test('every protocol verb validates a minimal legal body', () => {
    for (const [type, body] of Object.entries(VALID_BODIES)) {
      const r = validateMessage({ type, ...body });
      expect(r.success).toBe(true);
    }
  });

  test('optional fields survive validation', () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      ['position', { seq: 7, inputSeq: 6, ping: 40 }, ['seq', 'inputSeq', 'ping']],
      ['chat', { team: true }, ['team']],
      ['shotFired', { shotId: 's1', pos: { x: 1, y: 32, z: 0 } }, ['shotId', 'pos']],
      ['aoeShot', { projectileId: 'proj_2', excludeTargetId: 'p2', power: 1, directHit: true }, ['projectileId', 'excludeTargetId', 'power', 'directHit']],
      ['inputMove', { seq: 9 }, ['seq']],
      ['creatureHit', { kx: 0, ky: 0.5, kz: 0.86 }, ['kx', 'ky', 'kz']],
      ['switchRoom', { room: 'duel', mode: 'dm', map: 'arena', bots: 4 }, ['room', 'mode', 'map', 'bots']],
    ];
    for (const [type, opts, keys] of cases) {
      const r = validateMessage({ type, ...VALID_BODIES[type], ...opts });
      expect(r.success).toBe(true);
      if (r.success) {
        for (const k of keys) {expect((r.data as Record<string, unknown>)[k]).toEqual(opts[k]);}
      }
    }
  });

  test('unknown types and malformed bodies reject', () => {
    expect(validateMessage({ type: 'notARealVerb' }).success).toBe(false);
    expect(validateMessage('string').success).toBe(false);
    expect(validateMessage({}).success).toBe(false);
    expect(validateMessage({ type: 'chat', text: '' }).success).toBe(false);
    expect(validateMessage({ type: 'chat', text: 'x'.repeat(201) }).success).toBe(false);
    expect(validateMessage({ type: 'crawlerHit', id: -1, damage: 5 }).success).toBe(false);
    expect(validateMessage({ type: 'deploy', kind: 'nuke', position: { x: 0, y: 0, z: 0 } }).success).toBe(false);
  });
});
