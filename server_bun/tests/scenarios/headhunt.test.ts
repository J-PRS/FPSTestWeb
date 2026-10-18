import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, pin, step, replica } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { simNow, simMs } from '../../src/simClock.ts';
import { wallNow } from '../../src/wallClock.ts';

// Scenario: the headhunt loop end-to-end — coins pocket into held, the
// live score follows, a kill spills denomination coins at the corpse,
// and an enemy scooping the pile flips the board. Driven through the
// real damage/collect funnels, not roomScore calls.

function mkHH() {
  return mkRoom({ mode: 'headhunt', bots: 0 }, 'headhunt');
}

function heldMsgs(msgs: ServerMessage[], id: string): number[] {
  return msgs.filter((m): m is Extract<ServerMessage, { type: 'playerHeld' }> =>
    m.type === 'playerHeld' && m.playerId === id).map((m) => m.n);
}

function tokenVals(msgs: ServerMessage[]): number[] {
  return msgs.filter((m): m is Extract<ServerMessage, { type: 'pickupSpawn' }> =>
    m.type === 'pickupSpawn' && m.kind === 'token')
    .map((m) => m.val ?? 1).sort();
}

describe('scenario: headhunt hold economy', () => {
  it('touching a token pockets it — held, live score, playerHeld edge', () => {
    const room = mkHH();
    const w = watch(room);
    const p = room.players.addPlayer('P1', 'alpha');
    pin(room, 'P1', { x: 0, y: 31, z: 0 });
    room.pickups!.spawn({ x: 0.5, y: 31, z: 0 }, 'token');
    step(room, 2);
    expect(p.heldTokens).toBe(1);
    expect(room.scores.alpha).toBe(1);
    expect(room.scores.bravo).toBe(0);
    expect(heldMsgs(w.msgs, 'P1')).toEqual([1]);
    expect(w.count('teamScore')).toBeGreaterThanOrEqual(1);
  });

  it('a denomination coin pockets its full value', () => {
    const room = mkHH();
    const p = room.players.addPlayer('P1', 'alpha');
    pin(room, 'P1', { x: 0, y: 31, z: 0 });
    room.pickups!.spawn({ x: 0.5, y: 31, z: 0 }, 'token', 0, 9);
    step(room, 2);
    expect(p.heldTokens).toBe(9);
    expect(room.scores.alpha).toBe(9);
  });

  it('killing a 10-carrier spills blue + two whites at the corpse', () => {
    const room = mkHH();
    const w = watch(room);
    const p = room.players.addPlayer('P1', 'alpha');
    pin(room, 'P1', { x: 10, y: 31, z: 0 });
    room.scoring.setHeld(p, 10);
    expect(room.scores.alpha).toBe(10);
    room.players.applyDamage('P1', 500); // body dies…
    room.scoring.onKill('P1', 'environment'); // …the event funnel scatters
    step(room, 1);
    expect(p.heldTokens).toBe(0);
    expect(room.scores.alpha).toBe(0);
    // held 10 + 1 corpse bounty = 11 → 9 + 1 + 1.
    expect(tokenVals(w.msgs)).toEqual([1, 1, 9]);
    expect(heldMsgs(w.msgs, 'P1')).toContain(0);
    // The coins lie where the body fell — near the pinned spot.
    const snaps = room.pickups!.snapshot();
    expect(snaps.length).toBe(3);
    for (const s of snaps) {
      expect(Math.abs(s.pos.x - 10)).toBeLessThan(4);
    }
  });

  it('an enemy scooping the spill flips the live score', () => {
    const room = mkHH();
    const p1 = room.players.addPlayer('P1', 'alpha');
    room.players.addPlayer('P2', 'bravo');
    pin(room, 'P1', { x: 10, y: 31, z: 0 });
    pin(room, 'P2', { x: 10, y: 31, z: 0.5 });
    room.scoring.setHeld(p1, 5);
    room.players.applyDamage('P1', 500);
    room.scoring.onKill('P1', 'environment');
    step(room, 3); // spill lands, P2 sweeps it up where the corpse fell
    expect(room.scores.alpha).toBe(0);
    expect(room.scores.bravo).toBe(6); // 5 held + 1 bounty, all pocketed
    const p2 = room.players.getPlayer('P2')!;
    expect(p2.heldTokens).toBe(6);
  });

  it('tokens knock like every pickup — tumble then a rest resync', () => {
    const room = mkHH();
    const w = watch(room);
    room.players.addPlayer('P1', 'alpha');
    room.pickups!.spawn({ x: 0, y: 31, z: 0 }, 'token');
    const before = w.count('pickupSpawn');
    room.pickups!.knock({ x: 5, y: 31, z: 0 }, 20, 10);
    step(room, 20); // tumble + settle window
    // Settle republishes the rest spot as a spawn edge — that's what
    // converges every replica after a blast punt.
    expect(w.count('pickupSpawn')).toBeGreaterThan(before);
  });
});

describe('scenario: headhunt hoard-buff', () => {
  it('a 30-held carrier drips hp/armor/belt — a fresh hit mutes it all', () => {
    const room = mkHH();
    const p = room.players.addPlayer('P1', 'alpha');
    replica(room); // held drip lives in buildRecords — needs the fanout sim
    pin(room, 'P1', { x: 0, y: 31, z: 0 });
    p.hasReceivedPosition = true; // else skipRecord ghosts the record and the drip never ticks
    p.lastSeen = wallNow();
    room.scoring.setHeld(p, 30);
    p.health = 50;
    p.armor = 0;
    p.beltCharges = 0;
    p.beltAcc = 0;
    p.lastDamageAt = simMs(simNow() - 60_000); // long unhurt — buffs live
    step(room, 40); // 2s of drip
    expect(p.health).toBeGreaterThan(50);
    expect(p.armor).toBeGreaterThan(0);
    expect(p.beltCharges + p.beltAcc).toBeGreaterThan(0);
    // A hit mutes every channel for HELD_BUFF.graceMs — hoard is not armor-in-combat.
    const hpAtHit = p.health;
    const armorAtHit = p.armor;
    room.players.applyDamage('P1', 10); // armor absorbs 80% → ~2hp lands
    step(room, 40); // 2s inside the 8s grace — the drip must stay muted
    expect(p.health).toBeLessThanOrEqual(hpAtHit - 1.5);
    expect(p.armor).toBeLessThanOrEqual(armorAtHit - 7);
  });
});
