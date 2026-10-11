import { ChildLogger } from '../core/Logger.js';
import { registerDiag } from '../core/fxDiag.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { ServerMessage, TransportKind } from '../../../shared/protocol.js';

const logger = new ChildLogger('ClaimLedger');

// Reject census for the Alt+Q dump — the ERROR line logs the instance,
// this counts the PATTERN so "half my damage doesn't apply" is one
// dump line instead of a scrollback hunt.
export const rejectCensus = { total: 0, byReason: new Map<string, number>(), last: '' };
export const dedupCensus = { hitSeqDrops: 0 };
// Honest-lag drops (claimDropped wire) — separate from rejects so a dead
// target mid-claim doesn't pollute the "my claims get refused" signal.
export const dropCensus = { total: 0, byReason: new Map<string, number>(), last: '' };
// Resync-muted claim census — a beam held through a hidden-tab replay
// predicts damage with no wire behind it; "zapped him forever, zero
// damage" is this counter, not a reject.
const mutedCensus = { count: 0, lastWarnAt: 0 };
// Non-shot claim ledger (claimAck wire) — every stamped claim ends as
// accepted / rejected(reason) / unconfirmed (acked never came in the
// window) / lost (lane died first). The pattern line answers "did my
// deploy/heal/repair ever land" without a scrollback hunt.
export const claimCensus = {
  accepted: 0,
  rejected: 0,
  unconfirmed: 0,
  lost: 0,
  byReason: new Map<string, number>(),
  last: '',
};

export function noteMutedClaim(): void {
mutedCensus.count += 1;
  const now = performance.now();
  // First muted claim warns immediately; a held beam then folds to one
  // warn/second instead of a line per tic.
  if (mutedCensus.lastWarnAt !== 0 && now - mutedCensus.lastWarnAt < 1000) {return;}
  mutedCensus.lastWarnAt = now;
  logger.warn(`claim muted during resync replay (${mutedCensus.count} total) — predicted damage has no wire`);
}

registerDiag('net', () => ({
  rejects: {
    total: rejectCensus.total,
    byReason: Object.fromEntries(rejectCensus.byReason),
    last: rejectCensus.last,
  },
  dedup: { hitSeqDrops: dedupCensus.hitSeqDrops },
  claims: {
    accepted: claimCensus.accepted,
    rejected: claimCensus.rejected,
    unconfirmed: claimCensus.unconfirmed,
    lost: claimCensus.lost,
    byReason: Object.fromEntries(claimCensus.byReason),
    last: claimCensus.last,
  },
  drops: {
    total: dropCensus.total,
    byReason: Object.fromEntries(dropCensus.byReason),
    last: dropCensus.last,
  },
  mutedClaims: mutedCensus.count,
}));

/** Outbound-claim bookkeeping: predicted hits penciled in by shotId and
 *  seq-stamped non-shot claims, each swept against a confirm window so a
 *  claim that died silently surfaces as a classified counter, not a
 *  shrug. All verdicts feed the 'net' diag census above. */
export class ClaimLedger {
  /** Predicted-hit ledger: every shot claim against a player is penciled
   *  in by shotId; an inbound playerHit (me→same target) or a
   *  shotRejected clears it. If neither lands inside ~1.5s the predicted
   *  impact was phantom — the claim died on a transport flap or the
   *  server swallowed it without a reject — which is exactly the
   *  "exploded on his model but no damage" report. Swept lazily from
   *  bandwidth() (per-frame caller, gated to 250ms). */
  private pendingHits = new Map<string, { targetId: string; weaponType?: number; t: number }>();
  private lastPendingSweep = 0;
  private static readonly HIT_CONFIRM_MS = 1500;

  /** Non-shot claims (deploy/heal/repair/env/skill/creature hits) —
   *  seq-stamped on send, classified by claimAck or by expiry. */
  private pendingClaims = new Map<number, { kind: string; t: number }>();
  private claimSeq = 0;
  private creatureClaimN = 0;

  /** Stamp a claimSeq + ledger entry. `sparse` kinds (creature hits at
   *  chaingun rates) ack 1-in-4 — verdict traffic stays bounded, a
   *  rejected pattern still surfaces. Returns undefined when unsampled
   *  → legacy fire-and-forget, no ack expected. */
  stamp(kind: string, sparse = false): number | undefined {
    if (sparse && (((this.creatureClaimN += 1) - 1) & 3) !== 0) {return undefined;}
    this.claimSeq += 1;
    const seq = this.claimSeq;
    this.pendingClaims.set(seq, { kind, t: performance.now() });
    if (this.pendingClaims.size > 256) {
      // Acks aren't arriving at all — every waiting entry died with its
      // lane or its server; classify and reset rather than grow.
      claimCensus.lost += this.pendingClaims.size;
      claimCensus.last = 'ledger-full';
      logger.warn(`${this.pendingClaims.size} claim acks never arrived — classifying transport-lost`);
      this.pendingClaims.clear();
    }
    return seq;
  }

  noteShot(shotId: string, targetId: string, weaponType?: number): void {
    this.pendingHits.set(shotId, { targetId, weaponType, t: performance.now() });
  }

  confirmHit(targetId: string, shotId?: string): void {
    // shotRejected echoes the claim's shotId — match it exactly (two
    // claims racing the same target must not cross-clear). playerHit
    // carries no shotId, so confirm falls back to target — oldest
    // pending entry wins.
    if (shotId && this.pendingHits.delete(shotId)) {return;}
    for (const [id, h] of this.pendingHits) {
      if (h.targetId === targetId) { this.pendingHits.delete(id); return; }
    }
  }

  ack(data: Extract<ServerMessage, { type: 'claimAck' }>): void {
    this.pendingClaims.delete(data.seq);
    if (data.ok) {claimCensus.accepted += 1; return; }
claimCensus.rejected += 1;
    const key = `${data.kind}:${data.reason ?? '?'}`;
    claimCensus.byReason.set(key, (claimCensus.byReason.get(key) ?? 0) + 1);
    claimCensus.last = key;
    logger.warn(`claim rejected: ${key}`);
  }

  sweep(now: number, ctx: { pingMs: number; tier: TransportKind | string | undefined }): void {
    if (now - this.lastPendingSweep < 250) {return;}
    this.lastPendingSweep = now;
    // Per-claim warns here were a flood under sustained ack loss — every
    // waiting entry expired with its own interpolated line. The census
    // keeps per-kind counts; the log gets one line per sweep pass.
    let unacked = 0, oldest = 0;
    const byKind: Record<string, number> = {};
    for (const [seq, c] of this.pendingClaims) {
      if (now - c.t < ClaimLedger.HIT_CONFIRM_MS) {continue;}
      this.pendingClaims.delete(seq);
claimCensus.unconfirmed += 1;
unacked += 1;
      oldest = Math.max(oldest, Math.round(now - c.t));
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      const key = `${c.kind}:unconfirmed`;
      claimCensus.byReason.set(key, (claimCensus.byReason.get(key) ?? 0) + 1);
      claimCensus.last = key;
    }
    if (unacked > 0) {
      logger.warn(`${unacked} claim(s) never acked — dropped server-side or the acks died`, { byKind, oldestMs: oldest });
    }
    for (const [id, h] of this.pendingHits) {
      if (now - h.t < ClaimLedger.HIT_CONFIRM_MS) {continue;}
      this.pendingHits.delete(id);
rejectCensus.total += 1;
      rejectCensus.byReason.set('unconfirmed', (rejectCensus.byReason.get('unconfirmed') ?? 0) + 1);
      rejectCensus.last = `unconfirmed →${h.targetId}`;
      logger.warn(`predicted hit never confirmed — claim lost or silently dropped`, {
        shotId: id, targetId: h.targetId,
        weapon: h.weaponType === undefined ? undefined : WeaponType[h.weaponType] ?? h.weaponType,
        ageMs: Math.round(now - h.t), pingMs: ctx.pingMs, tier: ctx.tier,
      });
    }
  }

  /** Everything pending dies with the lane — acks can't arrive on a dead
   *  socket, so in-flight entries classify as transport-lost, not
   *  unconfirmed. Room switches just void the table (per-room seqs). */
  dropAll(countLost: boolean): void {
    if (countLost) {claimCensus.lost += this.pendingClaims.size;}
    this.pendingClaims.clear();
    this.pendingHits.clear();
  }
}
