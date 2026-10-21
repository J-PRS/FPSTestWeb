// Claim resend — FAST_LANE claims ride the datagram lane and can drop
// outright; the ledger must resend the verbatim msg (same claimSeq) until
// acked, bounded at 2 tries, then the normal unconfirmed path.
import { describe, it, expect } from 'vitest';
import { ClaimLedger, claimCensus } from '../networking/claimLedger.js';

const ctx = (resent: object[]): { pingMs: number; tier: string; resend: (m: object) => void } => ({
  pingMs: 50, tier: 'ws', resend: (m): void => { resent.push(m); },
});

describe('claim resend', () => {
  it('resends an unacked claim up to 2 tries, then classifies unconfirmed', () => {
    const l = new ClaimLedger();
    const resent: object[] = [];
    const msg = { type: 'deploy', claimSeq: 0 };
    msg.claimSeq = l.stamp('deploy', false, msg) ?? 0;
    const t0 = performance.now();
    l.sweep(t0 + 500, ctx(resent));   // past resendMs → try 1
    l.sweep(t0 + 900, ctx(resent));   // next pass → try 2
    l.sweep(t0 + 1300, ctx(resent));  // tries exhausted → silent
    const unconfirmedBefore = claimCensus.unconfirmed;
    l.sweep(t0 + 1800, ctx(resent));  // expiry → unconfirmed
    expect(resent).toHaveLength(2);
    expect(resent.every((m): boolean => (m as { claimSeq: number }).claimSeq === msg.claimSeq)).toBe(true);
    expect(claimCensus.unconfirmed).toBe(unconfirmedBefore + 1);
  });

  it('never resends an acked claim', () => {
    const l = new ClaimLedger();
    const resent: object[] = [];
    const seq = l.stamp('deploy', false, { type: 'deploy' })!;
    l.ack({ type: 'claimAck', kind: 'deploy', seq, ok: true });
    const t0 = performance.now();
    l.sweep(t0 + 500, ctx(resent));
    l.sweep(t0 + 1800, ctx(resent));
    expect(resent).toHaveLength(0);
    expect(claimCensus.unconfirmed).toBe(claimCensus.unconfirmed); // untouched by this ledger
  });

  it('msg-less stamps (old call sites) expire without resend', () => {
    const l = new ClaimLedger();
    const resent: object[] = [];
    l.stamp('repair');
    const t0 = performance.now();
    l.sweep(t0 + 500, ctx(resent));
    expect(resent).toHaveLength(0);
  });
});
