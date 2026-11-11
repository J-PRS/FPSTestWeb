import { describe, it, expect } from 'bun:test';
import { HitLedger, type LedgerHost } from '../src/hitLedger.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

/** Zero-damage resolves (soaked, immune, out-of-band splash) must not
 *  emit a playerHit edge - every client reads it as a white-pop flinch,
 *  so a null hit lies about contact. Pins the drop.zeroDamage gate on
 *  the shared funnel tail every damage path converges through. */

function host() {
  const players = new PlayerManager();
  players.addPlayer('victim');
  const broadcast: ServerMessage[] = [];
  const hbCounts = new Map<string, number>();
  const c = {
    broadcast: (m: ServerMessage): void => { broadcast.push(m); },
    playerManager: players,
    chargeBank: { of: (): number => 0, discharge: (): void => undefined, corpse: (): void => undefined },
    killFeed: {},
    respawner: {},
    hb: (k: string, n = 1): void => { hbCounts.set(k, (hbCounts.get(k) ?? 0) + n); },
    deps: {},
  } as unknown as LedgerHost;
  return { c, broadcast, hbCounts };
}

describe('hit ledger - zero damage gate', () => {
  it('a 0-damage resolve emits no playerHit and no ledger bookkeeping', () => {
    const { c, broadcast, hbCounts } = host();
    const ledger = new HitLedger();
    ledger.applyHit(c, 'shooter', 'victim', 0,
      { killed: false, newHealth: 125, newArmor: 0 },
      { label: 'aoe', weapon: 0 });
    expect(broadcast).toHaveLength(0);
    expect(hbCounts.get('drop.zeroDamage')).toBe(1);
    expect(hbCounts.get('hit')).toBeUndefined();
  });

  it('a real damage still emits the hit edge (guard is not a blanket drop)', () => {
    const { c, broadcast, hbCounts } = host();
    const ledger = new HitLedger();
    ledger.applyHit(c, 'shooter', 'victim', 25,
      { killed: false, newHealth: 100, newArmor: 0 },
      { label: 'aoe', weapon: 0 });
    expect(broadcast.length).toBeGreaterThan(0);
    expect(hbCounts.get('hit')).toBe(1);
  });
});
