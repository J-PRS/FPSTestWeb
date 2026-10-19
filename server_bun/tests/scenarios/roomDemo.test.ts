import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserializeDemo } from '../../../client/src/demo/demoReader.ts';
import { ProjectileEventType, TargetEventType } from '../../../client/src/demo/types.ts';

// Server-side demo capture (roomDemo.ts): FPS_DEMO=<dir> attaches a
// RoomDemo that records the authoritative wire stream — remoteFrames
// sampled off moveSim shadows, events mapped from broadcasts — and
// flushes a v7 .demo on room.dispose(). The client reads the same format;
// a server demo + client demo of the same match diff'd is the desync
// oracle.

let dir = '';
beforeEach((): void => {
  dir = mkdtempSync(join(tmpdir(), 'roomdemo-'));
  process.env.FPS_DEMO = dir;
});
afterEach((): void => {
  delete process.env.FPS_DEMO;
  rmSync(dir, { recursive: true, force: true });
});

describe('server demo capture', () => {
  it('records shadow frames + broadcast edges, flushes a valid .demo on dispose', () => {
    const room = mkRoom({ balls: { base: 0, perPlayer: 0, max: 0 } });
    expect(room.demo).toBeDefined();
    room.players.addPlayer('p1');
    room.players.addPlayer('p2');
    room.moveSim.track('p1', { x: 10, y: 60, z: 10 }, 0);
    room.moveSim.track('p2', { x: 30, y: 60, z: 30 }, 1);
    step(room, 40); // 2s of sim — remoteFrames sample ~20Hz

    // Authoritative wire edges a match emits.
    room.broadcast({ type: 'projectileCreated', projectileId: 's1', ownerId: 'p1',
      position: { x: 10, y: 62, z: 10 }, velocity: { x: 0, y: 5, z: 30 }, weaponType: 3 } as never);
    room.broadcast({ type: 'projectileDestroyed', projectileId: 's1',
      position: { x: 10, y: 62.5, z: 40 } } as never);
    room.broadcast({ type: 'playerKill', shooterId: 'p1', targetId: 'p2', weapon: 3 } as never);
    step(room, 5);

    const file = room.demo!.buildFile('test');
    expect(file.roster.length).toBe(2);
    expect(file.remoteFrames.length).toBeGreaterThan(10); // 2 players × ~2s × 20Hz
    expect(file.projectileEvents.filter(e => e.eventType === ProjectileEventType.Fired).length).toBe(1);
    expect(file.projectileEvents.filter(e => e.eventType === ProjectileEventType.Destroyed).length).toBe(1);
    const kill = file.targetEvents.filter(e => e.eventType === TargetEventType.Destroyed);
    expect(kill.length).toBe(1);
    expect(kill[0]!.targetType).toBe(224); // TARGETTYPE_KILL marker lane

    // Respawn re-seat stamps the Teleport bit — audits skip it (a 300m
    // jump is authoritative truth, not wire corruption).
    room.moveSim.resync('p1', { x: 900, y: 60, z: 900 }, 0, true);
    step(room, 2);
    const p1Idx = file.roster.findIndex(e => e.name === 'p1');
    room.dispose();
    const written = readdirSync(dir).filter((f): boolean => f.startsWith('t-') && f.endsWith('.demo'));
    expect(written.length).toBe(1);
    const back = deserializeDemo(readFileSync(join(dir, written[0]!)).buffer);
    const tele = back.remoteFrames.filter(f => f.rosterIdx === p1Idx && (f.flags & 4));
    expect(tele.length).toBeGreaterThan(0);
    expect(back.roster.length).toBe(2);
    expect(back.remoteFrames.length).toBeGreaterThanOrEqual(file.remoteFrames.length);
    expect(back.projectileEvents.length).toBe(2);
    expect(back.header.room).toBe('t');
  });
});
