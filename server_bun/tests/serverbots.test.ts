import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// A real field turns on the MoveSim path — bots then integrate through the
// same physics + energy economy as human shadows instead of direct writes.
const flat: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };

// ServerBots needs a Room for players/messages/assignTeam — a plain Room
// (no field, no sockets) is enough: broadcasts just hit zero recipients.

describe('ServerBots', () => {
  it('populates N bots as roster entries', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 4 }));
    expect(room.bots.count).toBe(4);
    expect(room.players.getPlayerCount()).toBe(4);
    expect(room.players.getPlayer('BOT-t1')?.isBot).toBe(true);
  });

  it('balances bots across teams in team modes', () => {
    const room = new Room('t', null, '', resolveMapSpec({ mode: 'nuggets', bots: 6 }));
    const teams = { alpha: 0, bravo: 0 };
    for (const p of room.players.getAllPlayers().values()) {
      if (p.team) teams[p.team]++;
    }
    expect(teams.alpha).toBe(3);
    expect(teams.bravo).toBe(3);
  });

  it('does not count bots toward room emptiness', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 3 }));
    expect(room.empty).toBe(true); // bots alone don't keep a match alive
  });

  it('humans keep the room alive alongside bots', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 3 }));
    room.players.addPlayer('human');
    expect(room.empty).toBe(false);
  });

  it('moves bots toward waypoints on tick', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-t1')!;
    const before = { ...p.position };
    for (let i = 0; i < 20; i++) room.bots.tick(0.05);
    const moved = Math.hypot(p.position.x - before.x, p.position.z - before.z);
    expect(moved).toBeGreaterThan(1);
    expect(p.lastSeq).toBeGreaterThan(0);
  });

  it('heartbeats lastSeen so the idle reaper skips socketless bots', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-t1')!;
    p.lastSeen = 0;
    room.bots.tick(0.05);
    expect(p.lastSeen).toBeGreaterThan(0);
  });

  it('untrack stops ticking a removed bot', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    room.bots.untrack('BOT-t1');
    const p = room.players.getPlayer('BOT-t1')!;
    const before = { ...p.position };
    room.bots.tick(0.05);
    expect(p.position).toEqual(before);
    expect(room.bots.count).toBe(0);
  });

  it('dead bots stop moving and firing', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-t1')!;
    p.isDead = true;
    const before = { ...p.position };
    const seq = p.lastSeq;
    room.bots.tick(0.05);
    expect(p.position).toEqual(before);
    expect(p.lastSeq).toBe(seq);
  });

  it('bots integrate through the move shadow when a field is attached', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1 }));
    const id = 'BOT-t1';
    expect(room.moveSim.simState(id)).not.toBeNull();
    const p = room.players.getPlayer(id)!;
    const before = { ...p.position };
    // Room ticks sims in order: bots set inputs, then moveSim steps them.
    for (let i = 0; i < 40; i++) { room.bots.tick(0.05); room.moveSim.tick(0.05); }
    const moved = Math.hypot(p.position.x - before.x, p.position.z - before.z);
    expect(moved).toBeGreaterThan(1);
    // The commit path writes the sim's velocity, not a synthetic hop.
    expect(Math.hypot(p.velocity.x, p.velocity.z)).toBeGreaterThan(0);
  });

  it('skill intents drain the shadow tank like a human claim', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1, mode: 'dm' }));
    const p = room.players.getPlayer('BOT-t1')!;
    p.health = 10; // hurt — the brain picks mend/shield, and the sim charges it
    const full = room.moveSim.energyOf('BOT-t1')!;
    for (let i = 0; i < 40; i++) { room.bots.tick(0.05); room.moveSim.tick(0.05); }
    expect(room.moveSim.energyOf('BOT-t1')!).toBeLessThan(full);
  });

  it('respawning a bot reseats the shadow at the new position', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1 }));
    const id = 'BOT-t1';
    const p = room.players.getPlayer(id)!;
    p.isDead = true;
    room.bots.tick(0.05); // marks the bot in deadSet
    // Room respawns the body somewhere new.
    p.isDead = false;
    p.position = { x: 300, y: 30, z: -200 };
    room.bots.tick(0.05);
    const sh = room.moveSim.simState(id)!;
    expect(Math.hypot(sh.pos.x - 300, sh.pos.z + 200)).toBeLessThan(30);
  });
});
