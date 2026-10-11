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
total += 1;
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
type DmgEcho = { victim: string; dmg: number; wt?: number; shotId?: string | null; at?: { x: number; y: number; z: number }; t: number };
const dmgEchoes: DmgEcho[] = [];
// Where each of MY shells actually detonated server-side (projectileDestroyed
// wire point), keyed by shotId — the fate half of the ghost-hit question.
// An unconfirmed echo + a fate far from the painted contact = trajectory
// divergence (server spawned/flight differed); an echo with NO fate = the
// server shell never even ran — intent lost, spawn refused, or its destroy
// never arrived.
const shellFates = new Map<string, { at: { x: number; y: number; z: number }; t: number }>();

export function expectDamageEcho(victim: string, dmg: number, wt?: number, shotId?: string | null, at?: { x: number; y: number; z: number }): void {
  dmgEchoes.push({ victim, dmg, wt, shotId, at, t: performance.now() });
  if (dmgEchoes.length > 32) {dmgEchoes.shift();}
}

export function confirmDamageEcho(victim: string): void {
  const i = dmgEchoes.findIndex(e => e.victim === victim);
  if (i !== -1) {dmgEchoes.splice(i, 1);}
}

export function noteShellFate(shotId: string, at: { x: number; y: number; z: number }): void {
  // Wire blast point — NaN turns every divergence diff against it into
  // NaN meters, which renders as a bogus "far" ghost in the dump.
  if (!Number.isFinite(at.x + at.y + at.z)) {return;}
  shellFates.set(shotId, { at, t: performance.now() });
  if (shellFates.size > 64) {
    // Sweep stale entries lazily — fates older than the confirm window
    // can't be needed by any live echo.
    const now = performance.now();
    for (const [k, f] of shellFates) {if (now - f.t > 15_000) {shellFates.delete(k);}}
  }
}

export function sweepDamageEchoes(now: number): void {
  for (let i = dmgEchoes.length - 1; i >= 0; i -= 1) {
    const e = dmgEchoes[i]!;
    if (now - e.t > 900) {
      const fate = e.shotId ? shellFates.get(e.shotId) : undefined;
      const detail: Record<string, unknown> = Object.assign({}, {victim: e.victim,dmg: e.dmg}, (e.wt === undefined ? {} : { wt: e.wt }));
      if (fate && e.at) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
        detail.offM = Number(Math.hypot(fate.at.x - e.at.x, fate.at.y - e.at.y, fate.at.z - e.at.z).toFixed(1));
      } else if (fate) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
      } else {
        detail.srvAt = 'none'; // server shell never detonated — intent died before it ran
      }
      parityMiss('dmg-echo', detail);
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
