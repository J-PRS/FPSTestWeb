import { describe, it, expect } from 'bun:test';
import { SessionRegistry } from '../../src/sessionRegistry.ts';

// A player in grace who re-begins (room hop while the seat is warm)
// replaces the session record — the prior record's grace countdown must
// die with it, or the dead session's onExpire fires against the NEW
// session's playerId and reaps a just-seated player.
describe('scenario: re-begin kills the orphaned grace timer', () => {
  it('grace expiry from the dead session never fires', async () => {
    const reg = new SessionRegistry();
    let expired = 0;
    reg.begin('p1', 'room-a');
    reg.seat('p1', false, 'test');
    expect(reg.disconnect('p1', 'socket dropped', 30, () => { expired++; })).toBe(true);

    // Re-begin replaces the session before the 30ms countdown lands.
    reg.begin('p1', 'room-b');
    reg.seat('p1', false, 'rejoin');

    await new Promise((r) => setTimeout(r, 80));
    expect(expired).toBe(0);
    // The new session is untouched — still seated, latest generation.
    expect(reg.state('p1')).toBe('active');
  });

  it('a grace timer that does fire still reaps exactly once', async () => {
    const reg = new SessionRegistry();
    let expired = 0;
    reg.begin('p2', 'room-a');
    reg.seat('p2', false, 'test');
    reg.disconnect('p2', 'socket dropped', 30, () => { expired++; });
    await new Promise((r) => setTimeout(r, 80));
    expect(expired).toBe(1);
  });
});
