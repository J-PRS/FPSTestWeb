import { describe, it, expect } from 'bun:test';
import { SessionRegistry } from '../../src/sessionRegistry.ts';

// roomGrace feeds Room.empty's per-tick dispose check — drift either
// way breaks teardown: a leaked +1 keeps an empty room immortal, a
// spurious -1 marks it empty while ghosts can still reclaim. Every
// exit path out of grace must balance the entry.
describe('scenario: grace ledger balances on every exit', () => {
  it('disconnect counts in, reclaim counts out', () => {
    const reg = new SessionRegistry();
    reg.begin('p1', 'room-a');
    reg.seat('p1', false, 'test');
    reg.disconnect('p1', 'socket dropped', 60_000, () => {});
    expect(reg.graceInRoom('room-a')).toBe(1);
    reg.reclaim('p1', 'reclaim');
    expect(reg.graceInRoom('room-a')).toBe(0);
  });

  it('terminate counts out — grace expiry, kick, idle reap', () => {
    const reg = new SessionRegistry();
    reg.begin('p1', 'room-a');
    reg.seat('p1', false, 'test');
    reg.disconnect('p1', 'socket dropped', 60_000, () => {});
    expect(reg.graceInRoom('room-a')).toBe(1);
    reg.terminate('p1', 'grace expired');
    expect(reg.graceInRoom('room-a')).toBe(0);
  });

  it('re-begin over a grace record releases the OLD room, not the new', () => {
    const reg = new SessionRegistry();
    reg.begin('p1', 'room-a');
    reg.seat('p1', false, 'test');
    reg.disconnect('p1', 'socket dropped', 60_000, () => {});
    expect(reg.graceInRoom('room-a')).toBe(1);
    // Room hop mid-grace: the new record belongs to room-b — room-a's
    // ghost count must release or the old room never reads as empty.
    reg.begin('p1', 'room-b');
    expect(reg.graceInRoom('room-a')).toBe(0);
    expect(reg.graceInRoom('room-b')).toBe(0);
  });

  it('multiple ghosts in one room count independently', () => {
    const reg = new SessionRegistry();
    for (const id of ['a', 'b', 'c']) { reg.begin(id, 'room-x'); reg.seat(id, false, 'test'); }
    reg.disconnect('a', 'dropped', 60_000, () => {});
    reg.disconnect('b', 'dropped', 60_000, () => {});
    expect(reg.graceInRoom('room-x')).toBe(2);
    reg.reclaim('a', 'reclaim');
    expect(reg.graceInRoom('room-x')).toBe(1);
    reg.terminate('b', 'expired');
    expect(reg.graceInRoom('room-x')).toBe(0);
  });
});
