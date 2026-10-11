import { describe, it, expect, vi, beforeEach } from 'vitest';
import {type ServerMessage, PROTOCOL_VERSION} from '../../../shared/protocol.js';

vi.mock('../core/sfx.js', () => ({ at: () => {}, shotAt: () => {}, init: () => {}, hitMarker: () => {}, playerHurt: () => {}, shieldHit: () => {}, killConfirm: () => {}, flagCue: () => {}, matchHorn: () => {} }));
// RemotePlayer's GLTF model fetch can't run headless — visual shell only.
vi.mock('../entities/PlayerModel.js', () => ({
  PlayerModel: function () {
    return new Proxy({ load: () => Promise.resolve() }, {
      get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => {}),
    });
  },
}));
globalThis.fetch = () => new Promise<Response>(() => {});

import { makeDeps, feed, feedBin } from './netHarness.js';

// Malformed-payload contract: one bad message must be absorbed — warn +
// continue — never thrown into the connection's onError path where it
// could cost a reconnect.
describe('net dispatch — malformed payloads', () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => { h = makeDeps(); });

  it('absorbs a handler throwing on a missing field, keeps dispatching', () => {
    // playerJoined without position/rotation hits a handler that
    // dereferences them — the guard must absorb it.
    expect(() => feed(h.nm, { type: 'playerJoined', playerId: 'p1' } as unknown as ServerMessage)).not.toThrow();
    // A valid message right after still processes — the bad packet
    // didn't poison the dispatcher.
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    feed(h.nm, { type: 'playerJoined', playerId: 'p2', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    feed(h.nm, { type: 'tickUpdate', updates: [{ playerId: 'p2', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false }] } as ServerMessage);
    expect(h.world.remotePlayers.has('p2')).toBe(true);
  });

  it('absorbs unknown message types', () => {
    expect(() => feed(h.nm, { type: 'madeUpType', foo: 1 } as unknown as ServerMessage)).not.toThrow();
  });

  it('absorbs a truncated binary frame', () => {
    // handleBinaryMessage with too few bytes must not throw.
    expect(() => feedBin(h.nm, new Uint8Array([0, 1]))).not.toThrow();
    expect(() => feedBin(h.nm, new Uint8Array([]))).not.toThrow();
  });
});
