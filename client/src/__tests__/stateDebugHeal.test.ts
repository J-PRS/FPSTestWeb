import { describe, it, expect, vi, beforeEach } from 'vitest';
import {wireStateDebug, type StateDebugContext} from '../core/stateDebug.js';
import { NetworkManager } from '../networking/NetworkManager.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Player } from '../entities/Player.js';
import type { SnapshotPlayer } from '../../../shared/protocol.js';

// The snapshot-heal path inside wireStateDebug is the roster's last-line
// recovery: hash mismatch → snapshot request → membership/health/liveness
// heal from server truth. Unpinned until now — a regression here degrades
// to "warns forever" instead of converging.

const log = { debug: (): void => { return; }, info: (): void => { return; }, warn: vi.fn(), error: (): void => { return; } };

function mk(): { nm: NetworkManager; ctx: StateDebugContext; remotePlayers: Map<string, RemotePlayer>; } {
  const nm = new NetworkManager();
  const remotePlayers = new Map<string, RemotePlayer>();
  const ctx: StateDebugContext = {
    networkManager: nm,
    getPlayer: (): Player => ({ health: 100, isDead: false }) as unknown as Player,
    remotePlayers: remotePlayers as StateDebugContext['remotePlayers'],
    projectiles: [],
    getLastSentPos: (): { x: number; y: number; z: number; } => ({ x: 0, y: 0, z: 0 }),
    world: { mode: 'test' },
    logger: log as unknown as StateDebugContext['logger'],
  };
  wireStateDebug(ctx);
  return { nm, ctx, remotePlayers };
}

// A mismatch forces sendSnapshotRequest; reply via the onSnapshot hook.
function snap(id: string, position: { x: number; y: number; z: number }, health: number, isDead: boolean): SnapshotPlayer {
  return { id, internalId: 0, position, rotation: 0, velocity: { x: 0, y: 0, z: 0 }, health, isDead, kills: 0, deaths: 0 } as unknown as SnapshotPlayer;
}

function driveSnapshot(ctx: StateDebugContext, serverPlayers: SnapshotPlayer[]): void {
  const nm = ctx.networkManager;
  let requested = false;
  const origSend = nm.sendSnapshotRequest.bind(nm);
  nm.sendSnapshotRequest = (): void => { requested = true; origSend(); };
  // Deliberately-mismatched server hash — 'zz' can't equal a computed FNV.
  nm.onStateHash?.('zz', 1, serverPlayers.length + 1, Date.now());
  expect(requested).toBe(true);
  nm.onSnapshot?.(serverPlayers, Date.now());
}

describe('stateDebug snapshot heal', (): void => {
  beforeEach((): void => { vi.clearAllMocks(); });

  it('a player the server has but the client lacks gets roster-seeded', (): void => {
    const { nm, ctx } = mk();
    driveSnapshot(ctx, [snap('ghost-1', { x: 1, y: 2, z: 3 }, 80, false)]);
    const p = nm.getPlayers().get('ghost-1');
    expect(p, 'missing member must be upserted from snapshot').toBeTruthy();
    expect(p!.health).toBe(80);
  });

  it('a roster member the server dropped gets remoteDelete-d', (): void => {
    const { nm, ctx, remotePlayers } = mk();
    nm.upsertRemotePlayer('stale-1', { position: { x: 0, y: 0, z: 0 }, health: 100, isDead: false });
    remotePlayers.set('stale-1', {} as RemotePlayer);
    let removed: string | null = null;
    (remotePlayers as StateDebugContext['remotePlayers']).remove = (id): true => { removed = id; return true; };
    driveSnapshot(ctx, []);
    expect(nm.getPlayers().has('stale-1'), 'stale member must be retired').toBe(false);
    expect(removed).toBe('stale-1');
  });

  it('health diverges beyond tolerance → healRemoteHealth lands', (): void => {
    const { nm, ctx } = mk();
    nm.upsertRemotePlayer('p1', { position: { x: 0, y: 0, z: 0 }, health: 100, isDead: false });
    driveSnapshot(ctx, [snap('p1', { x: 0, y: 0, z: 0 }, 40, false)]);
    expect(nm.getPlayers().get('p1')!.health).toBe(40);
  });

  it('liveness flip mirrors into the entity', (): void => {
    const { nm, ctx, remotePlayers } = mk();
    nm.upsertRemotePlayer('p1', { position: { x: 0, y: 0, z: 0 }, health: 100, isDead: false });
    const rp = { respawn: vi.fn(), playDeath: vi.fn() } as unknown as RemotePlayer;
    remotePlayers.set('p1', rp);
    driveSnapshot(ctx, [snap('p1', { x: 0, y: 0, z: 0 }, 0, true)]);
    expect(nm.getPlayers().get('p1')!.isDead).toBe(true);
    expect(rp.playDeath, 'dead flip must mirror to the entity').toHaveBeenCalled();
  });

  it('matching-ish snapshot still heals but warns only on real diffs', (): void => {
    const { nm, ctx } = mk();
    nm.upsertRemotePlayer('p1', { position: { x: 0, y: 0, z: 0 }, health: 99, isDead: false });
    driveSnapshot(ctx, [
      snap(nm.getLocalPlayerId(), { x: 0, y: 0, z: 0 }, 100, false),
      snap('p1', { x: 0, y: 0, z: 0 }, 99, false),
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
