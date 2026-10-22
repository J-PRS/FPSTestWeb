// Prediction-parity ledger — the complaint box for "client predicted X,
// server did Y". Settle points call noteMiss(kind, detail) when a wire
// truth disagrees with a local prediction; the alt+Q dump prints a
// census line plus the recent miss rows, so "my shot flew but the gem
// snapped back" is a named counter, not a vibe.
// Claims already have their own ledger (claimLedger.ts); this covers the
// predictions that have no claim behind them (blast knocks, pickup
// rests, self-shove echoes).

import { glitch, registerDiag } from '../core/fxDiag.js';
import { ChildLogger } from '../core/Logger.js';
import { WEAPONS, serverSimmed } from '../../../shared/weapons.js';

const logger = new ChildLogger('Parity');

const MAX_ROWS = 24;
const rows: { kind: string; detail: string; ageMs: number }[] = [];
const counts = new Map<string, number>();
const stamps = new Map<string, number>();
let total = 0;

/** The denominator half of the ledger: stamp once per prediction a kind
 *  can miss on, and the dump prints misses/stamps — a mispredict RATE,
 *  not a raw count. A climbing rate is the regression signal. */
export function parityStamp(kind: string): void {
  stamps.set(kind, (stamps.get(kind) ?? 0) + 1);
}

/** Shared kb-echo settle horizon: a remote-blast echo rides
 *  shooter-transit + our-transit, so the consume/expiry window must
 *  cover ~2·RTT + adjudication, not a flat 700 — at ~350ms RTT the echo
 *  lands ~900ms out and a 700ms expiry reports a false kb-echo.
 *  msSinceLiveRx stretches the window through wire silence so a stall
 *  delays (not refuses) the echo. */
export function kbEchoHorizon(rttMs: number, msSinceLiveRx: number): number {
  return Math.max(700, rttMs * 2 + 300) + Math.min(Math.max(0, msSinceLiveRx - 100), 2000);
}

export function parityMiss(kind: string, detail: Record<string, unknown>): void {
total += 1;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  rows.push({ kind, detail: JSON.stringify(detail), ageMs: Math.round(performance.now()) });
  if (rows.length > MAX_ROWS) {rows.splice(0, rows.length - MAX_ROWS);}
  // glitch() rate-limits the console line (3/kind then 1-in-100) — a parity
  // miss is rare and exactly what the complaint feed exists for, so emit a
  // WARN of our own whenever the limiter swallowed the GLITCH line.
  const payload = JSON.stringify(detail);
  if (glitch(`parity-${kind}`, detail)) {
    // Also log full JSON for the bot pilot soak capture
    console.error(`[GLITCH:parity-${kind}] ${payload}`);
  } else {
    logger.warn(`[GLITCH:parity-${kind}] ${payload}`);
  }
}

// Damage-echo expectations — in authority-sim rooms a predicted hit is
// feedback-only (numbers, hitmarker, predicted bars) with NO claim behind
// it: the claim ledger can't see it, so a server-side whiff reads as
// "my hit landed but did no damage". Stamp each predicted remote hit;
// a playerHit/kill naming the same victim confirms it, ~RTT of silence
// counts it as a ghost hit.
type DmgEcho = { victim: string; dmg: number; wt?: number; shotId?: string | null; at?: { x: number; y: number; z: number }; vWire?: { x: number; y: number; z: number }; t: number };
const dmgEchoes: DmgEcho[] = [];
// Where each of MY shells actually detonated server-side (projectileDestroyed
// wire point), keyed by shotId — the fate half of the ghost-hit question.
// An unconfirmed echo + a fate far from the painted contact = trajectory
// divergence (server spawned/flight differed); an echo with NO fate = the
// server shell never even ran — intent lost, spawn refused, or its destroy
// never arrived.
const shellFates = new Map<string, { at: { x: number; y: number; z: number }; t: number }>();

export function expectDamageEcho(victim: string, dmg: number, wt?: number, shotId?: string | null, at?: { x: number; y: number; z: number }, vWire?: { x: number; y: number; z: number }): void {
  parityProbes.echoesStamped += 1;
  parityStamp('dmg-echo');
  dmgEchoes.push({ victim, dmg, wt, shotId, at, vWire, t: performance.now() });
  if (dmgEchoes.length > 32) {dmgEchoes.shift();}
}

export function confirmDamageEcho(victim: string): void {
  const i = dmgEchoes.findIndex((e): boolean => e.victim === victim);
  if (i !== -1) {parityProbes.echoesConfirmed += 1; dmgEchoes.splice(i, 1);}
}

/** Telemetry audit: did a prediction stamp precede this wire hit? */
export function hasPendingEcho(victim: string): boolean {
  return dmgEchoes.some((e): boolean => e.victim === victim);
}

// ShotIds whose echo expired before a fate landed — a fate arriving into
// this set means 'none' was a timing false-positive (fuse still burning),
// not a truly dead intent.
const expiredShots = new Map<string, number>();

// Soak-visible counters — the pilot harness reads these to tell
// "intent never ran" from "destroy never arrived" without a packet dump.
export const parityProbes: {
  fatesSeen: number; echoesStamped: number; echoesConfirmed: number;
  destroysSeen: number; msgSeen: Record<string, number>;
} = { fatesSeen: 0, echoesStamped: 0, echoesConfirmed: 0, destroysSeen: 0, msgSeen: {} };

// My shells' replica-vs-fate distances — offM as a population, not just
// the misses' detail. A replica standing N meters from the server's
// detonation point when the gone edge lands is the trajectory-divergence
// census: the tail (p95) is the honest number a ghost-hit rate lives on.
const trajDivs: number[] = [];
// Outlier context — a 100m+ replica-vs-fate gap classifies differently
// if the replica already self-detonated (its own contact vs the wire's)
// than one still mid-flight at fate arrival (early server kill).
export function noteTrajDiv(d: number, wt?: number, selfPopped?: boolean, age?: number, boundAt?: number, srvAge?: number, mirrored?: boolean): void {
  trajDivs.push(d);
  if (trajDivs.length > 64) {trajDivs.shift();}
  if (d > 60) {parityMiss('traj-outlier', { m: Math.round(d), wt, self: selfPopped ? 1 : 0, age: age === undefined ? '?' : Number(age.toFixed(2)), bind: boundAt === undefined ? '?' : Number(boundAt.toFixed(2)), sa: srvAge === undefined ? '?' : Number(srvAge.toFixed(2)), mir: mirrored ? 1 : 0 });}
}
export function trajDivStats(): { n: number; p50: number; p95: number; max: number; over8: number } {
  const s = trajDivs.toSorted((a, b) => a - b);
  const q = (f: number): number => s.length > 0 ? Number(s[Math.min(s.length - 1, Math.floor(s.length * f))]!.toFixed(1)) : 0;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Number((s[s.length - 1] ?? 0).toFixed(1)), over8: s.filter((d) => d > 8).length };
}

export function noteShellFate(shotId: string, at: { x: number; y: number; z: number }): void {
  // Wire blast point — NaN turns every divergence diff against it into
  // NaN meters, which renders as a bogus "far" ghost in the dump.
  if (!Number.isFinite(at.x + at.y + at.z)) {return;}
  const late = expiredShots.get(shotId);
  if (late !== undefined) {parityMiss('fate-late', { shot: shotId, ageMs: Math.round(performance.now() - late) });}
  parityProbes.fatesSeen += 1;
  shellFates.set(shotId, { at, t: performance.now() });
  if (shellFates.size > 64) {
    // Sweep stale entries lazily — fates older than the confirm window
    // can't be needed by any live echo.
    const now = performance.now();
    for (const [k, f] of shellFates) {if (now - f.t > 15_000) {shellFates.delete(k);}}
  }
}

export function sweepDamageEchoes(now: number, stallMs = 0): void {
  for (let i = dmgEchoes.length - 1; i >= 0; i -= 1) {
    const e = dmgEchoes[i]!;
    // The verdict can't land before the server shell had time to run:
    // a predicted contact stamps NOW, but the server copy flies the same
    // fuse — a mortar's fate lands seconds after the predicted blast.
    // Budget = confirm window + weapon TTL (capped so complaints still
    // arrive promptly); weapons without a table row keep 900ms.
    // stallMs = inbound silence — a starved wire delays every verdict;
    // expiring mid-stall counts a delayed hit as a ghost.
    const ttlMs = e.wt === undefined ? 0 : (WEAPONS[e.wt]?.maxLifetime ?? 0) * 1000;
    const deadline = e.t + 900 + Math.min(ttlMs, 4100) + stallMs;
    if (now > deadline) {
      // Bodyless + carrier-spawned weapons (MRVBomblet, melee, beams)
      // have no shotId-bound shell fate — the client intent is never
      // reborn server-side, so a 'none' verdict can't distinguish a lost
      // intent from "no fate contract exists". Skip those: noise was
      // drowning the real verdicts (wt:29 srvAt:none in every soak).
      if (e.wt !== undefined && !serverSimmed(e.wt)) {dmgEchoes.splice(i, 1); continue;}
      const fate = e.shotId ? shellFates.get(e.shotId) : undefined;
      const detail: Record<string, unknown> = Object.assign({}, {victim: e.victim,dmg: e.dmg}, (e.wt === undefined ? {} : { wt: e.wt }), { shot: e.shotId ?? '?' });
      if (e.at) {detail.at = `${e.at.x.toFixed(0)},${e.at.y.toFixed(0)},${e.at.z.toFixed(0)}`;}
      // Aim staleness: the wire pos of the victim at stamp time vs the
      // point the hit painted — if the victim wasn't actually there, the
      // server legitimately missed no matter where the shell went.
      if (e.vWire && e.at) {
        detail.vWire = `${e.vWire.x.toFixed(0)},${e.vWire.y.toFixed(0)},${e.vWire.z.toFixed(0)}`;
        detail.aimOff = Number(Math.hypot(e.at.x - e.vWire.x, e.at.y - e.vWire.y, e.at.z - e.vWire.z).toFixed(1));
      }
      // Trajectory divergence: the server's detonate point vs the
      // predicted contact — if the shell itself flew differently, the
      // spawn claim/coalescing changed its arc.
      if (fate && e.at) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
        detail.offM = Number(Math.hypot(fate.at.x - e.at.x, fate.at.y - e.at.y, fate.at.z - e.at.z).toFixed(1));
      } else if (fate) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
      } else {
        detail.srvAt = 'none'; // server shell never detonated — intent died before it ran
      }
      parityMiss('dmg-echo', detail);
      if (e.shotId) {
        expiredShots.set(e.shotId, now);
        if (expiredShots.size > 64) {for (const [k, t0] of expiredShots) {if (now - t0 > 15_000) {expiredShots.delete(k);}}}
      }
      dmgEchoes.splice(i, 1);
    }
  }
}

/** Dump section — the census line leads, recent misses follow
 *  newest-first so a paste shows WHICH predictions died. */
export function parityLines(): string[] {
  const lines: string[] = [];
  const byKind = [...counts.entries()].map(([k, n]): string => {
    const s = stamps.get(k);
    return s ? `${k}=${n}/${s}(${(n / s * 100).toFixed(1)}%)` : `${k}=${n}`;
  }).join(' ');
  lines.push(`parity: misses=${total}${byKind ? ` ${byKind}` : ''}`);
  const td = trajDivStats();
  if (td.n > 0) {lines.push(`  shell-traj: n=${td.n} p50=${td.p50}m p95=${td.p95}m max=${td.max}m >8m=${td.over8}`);}
  for (const r of rows.slice(-8).toReversed()) {
    lines.push(`  parity-${r.kind}: ${r.detail}`);
  }
  return lines;
}

// Headless/soak path — __trailDump() merges every registerDiag section,
// so the parity census + trajectory audit land in collectDiag output too.
registerDiag('parity', () => ({
  misses: total,
  byKind: Object.fromEntries([...counts.entries()].map(([k, n]) => [k, `${n}/${stamps.get(k) ?? 0}`])),
  // Detail rows — the census hides WHICH prediction died; the ring keeps
  // the last 24 so a headless pull names the outliers (traj/dmg/kb).
  rows: rows.slice(-12).map((r) => `${r.kind} ${r.detail}`),
  trajDiv: trajDivStats(),
}));
