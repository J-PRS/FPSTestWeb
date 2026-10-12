/* oxlint-disable vitest/no-conditional-in-test -- table/fuzz harness: branchy drives and ?? fallbacks ARE the test logic */
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
  send(d: string | Uint8Array): void {
    if (typeof d === 'string') {this.json.push(JSON.parse(d));}
    else {this.bin.push(d);}
  }
  close(): void { this.closed = true; }
  lastJson(type: string) { return [...this.json].toReversed().find((m): boolean => m.type === type); }
}

function join(host: P2PHost, link: FakeLink, id: string): void {
  host.onData(link, JSON.stringify({ type: 'join', playerId: id }));
}

describe('P2PHost', (): void => {
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let host!: P2PHost;
  beforeEach((): void => { vi.useFakeTimers(); host = new P2PHost(); });
  afterEach((): void => { host.stop(); vi.useRealTimers(); });

  it('join produces gameState handshake', (): void => {
    const a = new FakeLink();
    join(host, a, 'HOST');
    const gs = a.lastJson('gameState') as { localPlayerState?: unknown; sessionToken?: string } | undefined;
    expect(gs).toBeDefined();
    expect(gs!.localPlayerState).toBeDefined();
  });

  it('rejects invalid playerId and closes the link', (): void => {
    const a = new FakeLink();
    join(host, a, '!!bad id with spaces!!');
    expect(a.closed).toBe(true);
    expect(a.lastJson('gameState')).toBeUndefined();
  });

  it('notifies the other peer on join and leave', (): void => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    // A join alone must not announce — that spawned ghost meshes at the
    // spawn default for peers who never entered the world. The announce
    // fires on B's first position report.
    expect(a.lastJson('playerJoined')).toBeUndefined();
    host.onData(b, encodePosition({ x: 1, y: 60, z: 1 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    expect(a.lastJson('playerJoined')).toMatchObject({ playerId: 'B' });
    host.onClose(b);
    expect(a.lastJson('playerLeft')).toMatchObject({ playerId: 'B' });
  });

  it('same-id rejoin evicts the stale link', (): void => {
    const a1 = new FakeLink(); const a2 = new FakeLink();
    join(host, a1, 'A'); join(host, a2, 'A');
    expect(a1.closed).toBe(true);
    expect(a2.lastJson('gameState')).toBeDefined();
  });

  it('forwards binary position frames to the peer at tick', (): void => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    host.onData(a, encodePosition({ x: 1, y: 2, z: 3 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    vi.advanceTimersByTime(60);
    expect(b.bin.length).toBeGreaterThan(0);
    const frame = b.bin[b.bin.length - 1];
    expect(isWireFrame(frame)).toBe(true);
    const tick = decodeTickFrame(frame);
    expect(tick!.updates.some((p): boolean => p.playerId === 'A' && p.position.x === 1)).toBe(true);
  });

  it('binary before join is ignored, not fatal', (): void => {
    const a = new FakeLink();
    host.onData(a, encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 0, 0));
    join(host, a, 'A');
    expect(a.lastJson('gameState')).toBeDefined();
  });

  it('shot claims route through validation and broadcast playerHit', (): void => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    // Park B at a known spot, then A fires a hit claim at point blank.
    host.onData(b, encodePosition({ x: 5, y: 60, z: 5 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    // A must report near the shot origin — spawn sanity rejects claims far
    // from the shooter's last position.
    host.onData(a, encodePosition({ x: 4, y: 60, z: 5 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    // Melee intent: shotFired carries only aim; the server derives the
    // arc point at A's position — B stands 1m along +x, inside reach.
    host.onData(a, JSON.stringify({
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    }));
    const hit = b.lastJson('playerHit') as { targetId?: string } | undefined;
    const hitToA = a.lastJson('playerHit') as { targetId?: string } | undefined;
    expect(hit?.targetId ?? hitToA?.targetId).toBe('B');
  });

  it('a simmed fire intent echoes projectileCreated with the shotId', (): void => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    host.onData(a, encodePosition({ x: 0, y: 60, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    host.onData(a, JSON.stringify({
      type: 'shotFired', weaponType: 0 /* BoltLauncher */, dir: { x: 1, y: 0.5, z: 0 },
      shotId: 's-1', pos: { x: 0, y: 61.6, z: 0 },
    }));
    const spawned = b.lastJson('projectileCreated') as { shotId?: string; ownerId?: string } | undefined;
    expect(spawned).toBeDefined();
    expect(spawned!.shotId).toBe('s-1');
    expect(spawned!.ownerId).toBe('A');
  });

  it('beam intents resolve through the host sweep — no claims', (): void => {
    const a = new FakeLink(); const b = new FakeLink();
    join(host, a, 'A'); join(host, b, 'B');
    // Lightning is light-locked — the class gate would reject the intent.
    (host as unknown as { playerManager: { getPlayer(id: string): { armorClass?: string } | undefined } })
      .playerManager.getPlayer('A')!.armorClass = 'light';
    host.onData(b, encodePosition({ x: 10, y: 60, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    host.onData(a, encodePosition({ x: 0, y: 60, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    host.onData(a, JSON.stringify({
      type: 'shotFired', weaponType: 12 /* Lightning */, dir: { x: 1, y: -0.16, z: 0 },
    }));
    const hit = b.lastJson('playerHit') as { targetId?: string } | undefined;
    const hitToA = a.lastJson('playerHit') as { targetId?: string } | undefined;
    expect(hit?.targetId ?? hitToA?.targetId).toBe('B');
  });

  it('malformed JSON is dropped without killing the link', (): void => {
    const a = new FakeLink();
    join(host, a, 'A');
    host.onData(a, '{not json');
    host.onData(a, JSON.stringify({ type: 'nonexistent-type' }));
    const b = new FakeLink();
    join(host, b, 'B');
    host.onData(b, encodePosition({ x: 1, y: 60, z: 1 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0));
    expect(a.lastJson('playerJoined')).toMatchObject({ playerId: 'B' });
  });
});
