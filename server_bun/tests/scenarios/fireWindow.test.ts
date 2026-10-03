import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// The spawn-claim fire-window law (shotClaims registerMiss): stamped
// claims carry cadence evidence on the client's own clock — a legal gap
// admits a fresh pull and decays violations; sustained sub-cadence racks
// violations to a reject (>=3), so one honest fast pair never punishes.
// Stampless claims can't prove spacing — a rolling-1s flood bound
// replaces them. This law is what stands between "paused-tab stamp
// bunch" and a real fire-rate macro, and it had zero coverage.

const GUN = 3; // Chaingun — interval 0.09s, slack = 76.5ms, burst 1, open to every class

function spyRejects(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const out: ServerMessage[] = [];
  const orig = room.connections.sendToPlayer.bind(room.connections);
  room.connections.sendToPlayer = (id, m) => { if (id === pid) out.push(m); else orig(id, m); };
  return out;
}

function spawnShot(room: ReturnType<typeof mkRoom>, pid: string, t?: number, shotId?: string): void {
  room.messages.handleMessage(pid, {
    type: 'shot', targetId: null,
    position: { x: 1, y: 32, z: 0 },
    velocity: { x: 30, y: 0, z: 0 },
    weaponType: GUN,
    ...(t !== undefined ? { timestamp: t } : {}),
    ...(shotId !== undefined ? { shotId } : {}),
  });
}

describe('scenario: fire-window law', () => {
  it('legal stamped cadence admits every spawn', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    // 120ms gaps > 110.5 slack — every pull legal.
    for (let i = 0; i < 4; i++) spawnShot(room, a.id, i * 120);
    expect(w.count('projectileCreated')).toBe(4);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(0);
  });

  it('sustained sub-cadence stamps reject on the third violation, not the first', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    // 50ms gaps — every pull past the first is sub-cadence evidence.
    // Violations at shot 2, 3, 4 → the 4th is the reject.
    for (let i = 0; i < 4; i++) spawnShot(room, a.id, i * 50);
    expect(w.count('projectileCreated')).toBe(3);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(1);
  });

  it('one honest fast pair then legal gaps never racks violations — decay works', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    // Alternating: fast pair, legal gap (decays), fast pair, legal gap…
    const stamps = [0, 50, 200, 250, 400, 450];
    for (const t of stamps) spawnShot(room, a.id, t);
    expect(w.count('projectileCreated')).toBe(6);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(0);
  });

  it('stampless claims flood-bound: a rolling-second swarm rejects, a backlog burst passes', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    // ceil(1000/76.5)+2 = 16 — the 16th arrival in the window rejects.
    for (let i = 0; i < 16; i++) spawnShot(room, a.id);
    expect(w.count('projectileCreated')).toBe(15);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(1);
  });

  it('dedup: a resent spawn nonce re-acks without consuming a fire-window slot', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    spawnShot(room, a.id, 0, 'shotA');
    // Immediate resend — sub-cadence but must bypass the gate entirely.
    spawnShot(room, a.id, 10, 'shotA');
    // Legal next pull still lands: dedup didn't eat the pull's budget.
    spawnShot(room, a.id, 200, 'shotB');
    expect(w.count('projectileCreated')).toBe(3); // shotA spawn + re-ack echo + shotB
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(0);
  });
});
