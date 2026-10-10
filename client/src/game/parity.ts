// Prediction-parity ledger — the complaint box for "client predicted X,
// server did Y". Settle points call noteMiss(kind, detail) when a wire
// truth disagrees with a local prediction; the alt+Q dump prints a
// census line plus the recent miss rows, so "my shot flew but the gem
// snapped back" is a named counter, not a vibe.
// Claims already have their own ledger (claimLedger.ts); this covers the
// predictions that have no claim behind them (blast knocks, pickup
// rests, self-shove echoes).

import { glitch } from '../core/fxDiag.js';

const MAX_ROWS = 24;
const rows: { kind: string; detail: string; ageMs: number }[] = [];
const counts = new Map<string, number>();
let total = 0;

export function parityMiss(kind: string, detail: Record<string, unknown>): void {
  total++;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  rows.push({ kind, detail: JSON.stringify(detail), ageMs: Math.round(performance.now()) });
  if (rows.length > MAX_ROWS) {rows.splice(0, rows.length - MAX_ROWS);}
  glitch(`parity-${kind}`, detail);
}

// Damage-echo expectations — in authority-sim rooms a predicted hit is
// feedback-only (numbers, hitmarker, predicted bars) with NO claim behind
// it: the claim ledger can't see it, so a server-side whiff reads as
// "my hit landed but did no damage". Stamp each predicted remote hit;
// a playerHit/kill naming the same victim confirms it, ~RTT of silence
// counts it as a ghost hit.
type DmgEcho = { victim: string; dmg: number; wt?: number; t: number };
const dmgEchoes: DmgEcho[] = [];

export function expectDamageEcho(victim: string, dmg: number, wt?: number): void {
  dmgEchoes.push({ victim, dmg, wt, t: performance.now() });
  if (dmgEchoes.length > 32) {dmgEchoes.shift();}
}

export function confirmDamageEcho(victim: string): void {
  const i = dmgEchoes.findIndex(e => e.victim === victim);
  if (i >= 0) {dmgEchoes.splice(i, 1);}
}

export function sweepDamageEchoes(now: number): void {
  for (let i = dmgEchoes.length - 1; i >= 0; i--) {
    const e = dmgEchoes[i]!;
    if (now - e.t > 900) {
      parityMiss('dmg-echo', { victim: e.victim, dmg: e.dmg, ...(e.wt !== undefined ? { wt: e.wt } : {}) });
      dmgEchoes.splice(i, 1);
    }
  }
}

/** Dump section — the census line leads, recent misses follow
 *  newest-first so a paste shows WHICH predictions died. */
export function parityLines(): string[] {
  const lines: string[] = [];
  const byKind = [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
  lines.push(`parity: misses=${total}${byKind ? ` ${byKind}` : ''}`);
  for (const r of rows.slice(-8).reverse()) {
    lines.push(`  parity-${r.kind}: ${r.detail}`);
  }
  return lines;
}
