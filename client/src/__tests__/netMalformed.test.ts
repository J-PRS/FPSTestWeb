import { describe, it, expect, vi, beforeEach } from 'vitest';
import {type ServerMessage, PROTOCOL_VERSION} from '../../../shared/protocol.js';

import { makeDeps, feed, feedBin } from './netHarness.js';
vi.mock('../core/sfx.js', () => ({ at: (): void => { return; }, shotAt: (): void => { return; }, init: (): void => { return; }, hitMarker: (): void => { return; }, playerHurt: (): void => { return; }, shieldHit: (): void => { return; }, killConfirm: (): void => { return; }, flagCue: (): void => { return; }, matchHorn: (): void => { return; } }));
// RemotePlayer's GLTF model fetch can't run headless — visual shell only.
vi.mock('../entities/PlayerModel.js', (): { PlayerModel: () => { load: () => Promise<void>; }; } => ({
  PlayerModel: function (): { load: () => Promise<void>; } {
    return new Proxy({ load: (): Promise<void> => Promise.resolve() }, {
      get: (t, k): unknown => (k in t ? (t as Record<PropertyKey, unknown>)[k] : (): void => { return; }),
    });
  },
}));
globalThis.fetch = ((): Promise<Response> => new Promise<Response>((): void => { return; })) as unknown as typeof fetch;


// Malformed-payload contract: one bad message must be absorbed — warn +
// continue — never thrown into the connection's onError path where it
// could cost a reconnect.
describe('net dispatch — malformed payloads', (): void => {
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let h!: ReturnType<typeof makeDeps>;
  beforeEach((): void => { h = makeDeps(); });

  it('absorbs a handler throwing on a missing field, keeps dispatching', (): void => {
    // playerJoined without position/rotation hits a handler that
    // dereferences them — the guard must absorb it.
    expect((): void => feed(h.nm, { type: 'playerJoined', playerId: 'p1' } as unknown as ServerMessage)).not.toThrow();
    // A valid message right after still processes — the bad packet
    // didn't poison the dispatcher.
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    feed(h.nm, { type: 'playerJoined', playerId: 'p2', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    feed(h.nm, { type: 'tickUpdate', updates: [{ playerId: 'p2', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false }] } as ServerMessage);
    expect(h.world.remotePlayers.has('p2')).toBe(true);
  });

  it('absorbs unknown message types', (): void => {
    expect((): void => feed(h.nm, { type: 'madeUpType', foo: 1 } as unknown as ServerMessage)).not.toThrow();
  });

  it('absorbs a truncated binary frame', (): void => {
    // handleBinaryMessage with too few bytes must not throw.
    expect((): void => feedBin(h.nm, new Uint8Array([0, 1]))).not.toThrow();
    expect((): void => feedBin(h.nm, new Uint8Array([]))).not.toThrow();
  });
});
