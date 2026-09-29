/**
 * P2PHost authority tests — fake P2PLinks stand in for loopback/DataChannel,
 * exercising join → handshake → tick → shot → leave against the REAL server
 * modules (PlayerManager/MessageHandler/validation) the host embeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { P2PHost, type P2PLink } from '../networking/p2p/host.js';
import { encodePosition, decodeTickFrame, isWireFrame } from '../../../shared/wire.js';
import type { ServerMessage } from '../../../shared/protocol.js';

class FakeLink implements P2PLink {
  json: ServerMessage[] = [];
  bin: Uint8Array[] = [];
  closed = false;
  send(d: string | Uint8Array) {
    if (typeof d === 'string') this.json.push(JSON.parse(d));
    else this.bin.push(d);
  }
  close() { this.closed = true; }
  lastJson(type: string) { return [...this.json].toReversed().find(m => m.type === type); }
}

function join(host: P2PHost, link: FakeLink, id: string) {
  host.onData(link, JSON.stringify({ type: 'join', playerId: id }));
}

describe('P2PHost', () => {
  let host: P2PHost;
  beforeEach(() => { vi.useFakeTimers(); host = new P2PHost(); });
  afterEach(() => { host.stop(); vi.useRealTimers(); });

  it('join produces gameState handshake', () => {
    const a = new FakeLink();
    join(host, a, 'HOST');
    const gs = a.lastJson('gameState') as { localPlayerState?: unknown; sessionToken?: string } | undefined;
    expect(gs).toBeDefined();
    expect(gs!.localPlayerState).toBeDefined();
  });

  it('rejects invalid playerId and closes the link', () => {
    const a = new FakeLink();
    join(host, a, '!!bad id with spaces!!');
    expect(a.closed).toBe(true);
    expect(a.lastJson('gameState')).toBeUndefined();
  });

  it('notifies the other peer on join and leave', () => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    expect(a.lastJson('playerJoined')).toMatchObject({ playerId: 'B' });
    host.onClose(b);
    expect(a.lastJson('playerLeft')).toMatchObject({ playerId: 'B' });
  });

  it('same-id rejoin evicts the stale link', () => {
    const a1 = new FakeLink(); const a2 = new FakeLink();
    join(host, a1, 'A'); join(host, a2, 'A');
    expect(a1.closed).toBe(true);
    expect(a2.lastJson('gameState')).toBeDefined();
  });

  it('forwards binary position frames to the peer at tick', () => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    host.onData(a, encodePosition({ x: 1, y: 2, z: 3 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    vi.advanceTimersByTime(60);
    expect(b.bin.length).toBeGreaterThan(0);
    const frame = b.bin[b.bin.length - 1];
    expect(isWireFrame(frame)).toBe(true);
    const tick = decodeTickFrame(frame);
    expect(tick!.updates.some(p => p.playerId === 'A' && p.position.x === 1)).toBe(true);
  });

  it('binary before join is ignored, not fatal', () => {
    const a = new FakeLink();
    host.onData(a, encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 0, 0));
    join(host, a, 'A');
    expect(a.lastJson('gameState')).toBeDefined();
  });

  it('shot claims route through validation and broadcast playerHit', () => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    // Park B at a known spot, then A fires a hit claim at point blank.
    host.onData(b, encodePosition({ x: 5, y: 60, z: 5 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    // A must report near the shot origin — spawn sanity rejects claims far
    // from the shooter's last position.
    host.onData(a, encodePosition({ x: 4, y: 60, z: 5 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    // Register the projectile (miss-phase shot), then claim the hit on it.
    // The server names projectiles itself (proj_N); a null claim falls back
    // to the shooter's most recent spawn of that weapon type.
    host.onData(a, JSON.stringify({
      type: 'shot', targetId: null, weaponType: 0,
      position: { x: 4, y: 60, z: 5 }, velocity: { x: 50, y: 0, z: 0 },
    }));
    host.onData(a, JSON.stringify({
      type: 'shot', targetId: 'B', weaponType: 0, projectileId: null,
      position: { x: 5, y: 60, z: 5 }, airtime: 0.02, // seconds — 50m/s × 0.02s = 1m: origin (4) → hit (5)
    }));
    const hit = b.lastJson('playerHit') as { targetId?: string } | undefined;
    const hitToA = a.lastJson('playerHit') as { targetId?: string } | undefined;
    expect(hit?.targetId ?? hitToA?.targetId).toBe('B');
  });

  it('malformed JSON is dropped without killing the link', () => {
    const a = new FakeLink();
    join(host, a, 'A');
    host.onData(a, '{not json');
    host.onData(a, JSON.stringify({ type: 'nonexistent-type' }));
    const b = new FakeLink();
    join(host, b, 'B');
    expect(a.lastJson('playerJoined')).toMatchObject({ playerId: 'B' });
  });
});
