import { describe, expect, it } from 'bun:test';
import { mkRoom, firstPlayer, pin } from './harness.ts';

// Team rooms gate heal claims behind gem credit — gems collected on the
// field are the only legal way to self-heal (Room's onCollect grants +25).
// Without credit a claim is silently dropped; with credit the claim
// drains it 1:1 and can't exceed the stored amount.

describe('heal credit (team rooms)', () => {
  it('drops a heal claim with no gem credit', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    p.health = 50;
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(50); // no credit, no heal
  });

  it('heals up to stored credit and drains it', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    p.health = 50;
    p.healCredit = 10; // as if ~half a gem pick was already spent
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(60); // claim clamped to the 10 held
    expect(p.healCredit).toBe(0); // bank empty
  });

  it('non-team rooms heal free-form (no credit needed)', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    p.health = 50;
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(75);
  });
});
