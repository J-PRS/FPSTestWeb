import { wallMs } from '../../src/wallClock.ts';
import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

function wsSpy(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const got: ServerMessage[] = [];
  room.connections.register(pid, {
    readyState: 1,
    send: (d: string | ArrayBuffer | Uint8Array) => { got.push(JSON.parse(d as string) as ServerMessage); return 0; },
  } as never);
  return got;
}

describe('scenario: ping/snapshot', () => {
  it('ping echoes a pong with the same timestamp and counts as liveness', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const sent = wsSpy(room, p.id);
    p.lastSeen = wallMs(0);
    room.messages.handleMessage(p.id, { type: 'ping', timestamp: 123456 });
    const pong = sent.find((m) => m.type === 'pong') as { timestamp: number } | undefined;
    expect(pong?.timestamp).toBe(123456);
    expect(p.lastSeen).toBeGreaterThan(0); // ping is a liveness signal too
  });

  it('snapshotRequest replies with the full roster state to the requester only', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    const toA = wsSpy(room, a.id);
    const toB = wsSpy(room, b.id);
    a.kills = 3;
    b.health = 42;
    room.messages.handleMessage(a.id, { type: 'snapshotRequest' });
    const snap = toA.find((m) => m.type === 'snapshot') as { players: { id: string; kills: number; health: number }[] } | undefined;
    expect(snap).toBeTruthy();
    expect(snap!.players.length).toBe(2);
    const me = snap!.players.find((pl) => pl.id === a.id)!;
    const them = snap!.players.find((pl) => pl.id === b.id)!;
    expect(me.kills).toBe(3);
    expect(them.health).toBe(42);
    // World rosters ride along — the desync monitor heals object lanes
    // here too, not just players.
    expect(toA.some((m) => m.type === 'ballRoster')).toBe(true);
    expect(toB.length).toBe(0); // reply goes to the requester, never the room
  });

  it('snapshotRequest heals object lanes — flags/pickups/deploys replay like a fresh join', () => {
    // A mid-game client that desynced its non-player state had no path
    // back (only players healed): the stateHash monitor warned forever.
    // The resync now replays the same world rosters a joiner gets.
    const room = mkRoom({
      mode: 'ctf',
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    room.players.addPlayer('A');
    const a = room.players.getPlayer('A')!;
    a.team = 'alpha';
    room.pickups!.spawn({ x: 5, y: 31, z: 5 }, 'gem');
    room.deployables.seedBase([{ kind: 'generator', pos: { x: 10, y: 30, z: 10 }, team: 'alpha' }]);
    const toA = wsSpy(room, a.id);
    room.messages.handleMessage(a.id, { type: 'snapshotRequest' });
    expect(toA.some((m) => m.type === 'flagUpdate')).toBe(true);
    expect(toA.some((m) => m.type === 'pickupSpawn')).toBe(true);
    expect(toA.some((m) => m.type === 'deploySpawn')).toBe(true);
  });

  it('resync replays the join payload — gameState + local state, requester only', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    const toA = wsSpy(room, a.id);
    const toB = wsSpy(room, b.id);
    b.health = 42;
    room.messages.handleMessage(a.id, { type: 'resync' });
    const gs = toA.find((m) => m.type === 'gameState') as {
      players: { id: string }[];
      localPlayerState?: { position: { x: number } };
      team?: string;
    } | undefined;
    expect(gs).toBeTruthy();
    expect(gs!.players.every((pl) => pl.id !== a.id)).toBe(true); // roster is others-only
    expect(gs!.players.some((pl) => pl.id === b.id)).toBe(true);
    expect(gs!.localPlayerState).toBeTruthy(); // own truth comes via localPlayerState
    expect(toB.length).toBe(0);
  });
});
