// Prediction-parity ledger - the complaint box for "client predicted X,
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
 *  can miss on, and the dump prints misses/stamps - a mispredict RATE,
 *  not a raw count. A climbing rate is the regression signal. */
export function parityStamp(kind: string): void {
  stamps.set(kind, (stamps.get(kind) ?? 0) + 1);
}

/** Shared kb-echo settle horizon: a remote-blast echo rides
 *  shooter-transit + our-transit, so the consume/expiry window must
 *  cover ~2·RTT + adjudication, not a flat 700 - at ~350ms RTT the echo
 *  lands ~900ms out and a 700ms expiry reports a false kb-echo.
 *  msSinceLiveRx stretches the window through wire silence so a stall
 *  delays (not refuses) the echo. */
export function kbEchoHorizon(rttMs: number, msSinceLiveRx: number): number {
  // Floor 1000 not 700: when every RTT probe reads 0 (ws tier, worker
  // owns the probe, srvPing not landed yet) the echo round-trip is still
  // real - a flat 700ms falsely expired WAN echoes at ~714ms (tsDuel10).
  return Math.max(1000, rttMs * 2 + 300) + Math.min(Math.max(0, msSinceLiveRx - 100), 2000);
}

export function parityMiss(kind: string, detail: Record<string, unknown>): void {
total += 1;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  rows.push({ kind, detail: JSON.stringify(detail), ageMs: Math.round(performance.now()) });
  if (rows.length > MAX_ROWS) {rows.splice(0, rows.length - MAX_ROWS);}
  // glitch() rate-limits the console line (3/kind then 1-in-100) - a parity
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

// Damage-echo expectations - in authority-sim rooms a predicted hit is
// feedback-only (numbers, hitmarker, predicted bars) with NO claim behind
// it: the claim ledger can't see it, so a server-side whiff reads as
// "my hit landed but did no damage". Stamp each predicted remote hit;
// a playerHit/kill naming the same victim confirms it, ~RTT of silence
// counts it as a ghost hit.
type DmgEcho = { victim: string; dmg: number; wt?: number; shotId?: string | null; at?: { x: number; y: number; z: number }; vWire?: { x: number; y: number; z: number }; t: number };
const dmgEchoes: DmgEcho[] = [];
// Where each of MY shells actually detonated server-side (projectileDestroyed
// wire point), keyed by shotId - the fate half of the ghost-hit question.
// An unconfirmed echo + a fate far from the painted contact = trajectory
// divergence (server spawned/flight differed); an echo with NO fate = the
// server shell never even ran - intent lost, spawn refused, or its destroy
// never arrived.
const shellFates = new Map<string, { at: { x: number; y: number; z: number }; t: number }>();

export function expectDamageEcho(victim: string, dmg: number, wt?: number, shotId?: string | null, at?: { x: number; y: number; z: number }, vWire?: { x: number; y: number; z: number }): void {
  parityProbes.echoesStamped += 1;
  // A multi-part blast stamps once per sub-shell on the same victim - a
  // ClusterBomb fans into ~5 bomblets (wt:22, no shotId) that each splash
  // the same player. That's ONE predicted outcome: if the queue held five
  // entries, one wire hit confirmed a single splice and the other four
  // expired as false ghost-misses. Merge same victim+wt+shotId stamps.
  const shotKey = shotId ?? null;
  const prev = dmgEchoes.find((e): boolean => e.victim === victim && e.wt === wt && (e.shotId ?? null) === shotKey);
  if (prev) {
    prev.dmg += dmg;
    prev.t = performance.now(); // verdict window rides the last stamp
  } else {
    parityStamp('dmg-echo');
    dmgEchoes.push({ victim, dmg, wt, shotId, at, vWire, t: performance.now() });
    if (dmgEchoes.length > 32) {dmgEchoes.shift();}
  }
}

export function confirmDamageEcho(victim: string, shotId?: string | null): void {
  // Shot-aware consume: multiple pending echoes on one victim (fan
  // bursts, fast re-shots) must not let a stray confirm eat the wrong
  // stamp - prefer the shotId match, fall back to victim-only.
  let i = shotId ? dmgEchoes.findIndex((e): boolean => e.victim === victim && (e.shotId ?? null) === shotId) : -1;
  if (i === -1) {i = dmgEchoes.findIndex((e): boolean => e.victim === victim);}
  if (i !== -1) {parityProbes.echoesConfirmed += 1; dmgEchoes.splice(i, 1);}
}

/** Telemetry audit: did a prediction stamp precede this wire hit? */
export function hasPendingEcho(victim: string): boolean {
  return dmgEchoes.some((e): boolean => e.victim === victim);
}

// ShotIds whose echo expired before a fate landed - a fate arriving into
// this set means 'none' was a timing false-positive (fuse still burning),
// not a truly dead intent.
const expiredShots = new Map<string, number>();

// Wire death times per victim - the server skips dead targets in the
// AOE sweep entirely (no refuse, no hit): a painted contact on a corpse
// can never confirm, so dying-around-the-stamp voids the verdict rather
// than proving a miss.
const victimDiedAt = new Map<string, number>();
export function noteVictimDeath(victim: string): void {
  victimDiedAt.set(victim, performance.now());
  if (victimDiedAt.size > 64) {const now = performance.now(); for (const [k, t] of victimDiedAt) {if (now - t > 60_000) {victimDiedAt.delete(k);}}}
}
export function noteVictimRespawn(victim: string): void { victimDiedAt.delete(victim); }

// Soak-visible counters - the pilot harness reads these to tell
// "intent never ran" from "destroy never arrived" without a packet dump.
export const parityProbes: {
  fatesSeen: number; echoesStamped: number; echoesConfirmed: number;
  destroysSeen: number; deadOnArrival: number; trajUnbound?: number; trajBounced?: number; echoesVoided?: number; msgSeen: Record<string, number>;
} = { fatesSeen: 0, echoesStamped: 0, echoesConfirmed: 0, destroysSeen: 0, deadOnArrival: 0, msgSeen: {} };

// My shells' replica-vs-fate distances - offM as a population, not just
// the misses' detail. A replica standing N meters from the server's
// detonation point when the gone edge lands is the trajectory-divergence
// census: the tail (p95) is the honest number a ghost-hit rate lives on.
const trajDivs: number[] = [];
// Outlier context - a 100m+ replica-vs-fate gap classifies differently
// if the replica already self-detonated (its own contact vs the wire's)
// than one still mid-flight at fate arrival (early server kill).
export function noteTrajDiv(d: number, wt?: number, selfPopped?: boolean, age?: number, boundAt?: number, srvAge?: number, mirrored?: boolean): void {
  // Two populations, different meanings: an UNBOUND replica (the create
  // echo never re-anchored it) flies its live-muzzle arc - offset from
  // the server shell by shooter-speed × spawn-lag (~10-20m is normal,
  // that's the divergence the re-anchor exists to erase). Mixing it into
  // trajDivs makes the p50 read echo loss as arc divergence, so unbound
  // samples get their own counter and only bound replicas feed the stat.
  if (boundAt === undefined || boundAt < 0) {parityProbes.trajUnbound = (parityProbes.trajUnbound ?? 0) + 1; return;}
  trajDivs.push(d);
  if (trajDivs.length > 64) {trajDivs.shift();}
  if (d > 60) {parityMiss('traj-outlier', { m: Math.round(d), wt, self: selfPopped ? 1 : 0, age: age === undefined ? '?' : Number(age.toFixed(2)), bind: Number(boundAt.toFixed(2)), sa: srvAge === undefined ? '?' : Number(srvAge.toFixed(2)), mir: mirrored ? 1 : 0 });}
}
export function trajDivStats(): { n: number; p50: number; p95: number; max: number; over8: number } {
  const s = trajDivs.toSorted((a, b) => a - b);
  const q = (f: number): number => s.length > 0 ? Number(s[Math.min(s.length - 1, Math.floor(s.length * f))]!.toFixed(1)) : 0;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Number((s[s.length - 1] ?? 0).toFixed(1)), over8: s.filter((d) => d > 8).length };
}

export function noteShellFate(shotId: string, at: { x: number; y: number; z: number }): void {
  // Wire blast point - NaN turns every divergence diff against it into
  // NaN meters, which renders as a bogus "far" ghost in the dump.
  if (!Number.isFinite(at.x + at.y + at.z)) {return;}
  const late = expiredShots.get(shotId);
  if (late !== undefined) {parityMiss('fate-late', { shot: shotId, ageMs: Math.round(performance.now() - late) });}
  parityProbes.fatesSeen += 1;
  shellFates.set(shotId, { at, t: performance.now() });
  if (shellFates.size > 64) {
    // Sweep stale entries lazily - fates older than the confirm window
    // can't be needed by any live echo.
    const now = performance.now();
    for (const [k, f] of shellFates) {if (now - f.t > 15_000) {shellFates.delete(k);}}
  }
}

/** pid → the wire's detonation point - set on every projectileDestroyed
 *  carrying a position; read by remote-blast shove prediction so a
 *  self-popped replica (destroy already landed) evaluates the envelope
 *  at the server's true center, not its painted contact. */
export const projWireAt = new Map<string, { at: { x: number; y: number; z: number }; t: number }>();

/** Deadline for a kb-echo stamp. A pid-bound stamp's verdict can't
 *  exist before the server shell's fate lands - a replica that popped
 *  early on its painted contact otherwise expires before the wire
 *  destroy (and the knockback echo riding behind it) ever arrives,
 *  which turns a late-but-legit echo into a raw double-shove + a false
 *  kb-echo miss. No pid = no fate contract - the plain horizon. */

export function kbStampDeadline(s: { t: number; pid?: string; wt?: number; wireT?: number }, horizon: number): number {
  if (s.wireT) {return s.wireT + horizon;} // echo rides ~one transit behind the destroy
  // Server shell may outlive the replica's early self-pop by its whole
  // life - a fly-until-contact disc's fate only lands at ABSOLUTE_TTL,
  // so cap at maxLifetime+transit rather than a fixed window.
  if (s.pid) {return s.t + horizon + Math.min((s.wt === undefined ? 2000 : (WEAPONS[s.wt]?.maxLifetime ?? 2) * 1000), 9000) + 1500;}
  return s.t + horizon;
}

export function sweepDamageEchoes(now: number, stallMs = 0): void {
  for (let i = dmgEchoes.length - 1; i >= 0; i -= 1) {
    const e = dmgEchoes[i]!;
    // The verdict can't land before the server shell had time to run:
    // a predicted contact stamps NOW, but the server copy flies the same
    // fuse - a mortar's fate lands seconds after the predicted blast.
    // Budget = confirm window + weapon TTL (capped so complaints still
    // arrive promptly); weapons without a table row keep 900ms.
    // stallMs = inbound silence - a starved wire delays every verdict;
    // expiring mid-stall counts a delayed hit as a ghost.
    const ttlMs = e.wt === undefined ? 0 : (WEAPONS[e.wt]?.maxLifetime ?? 0) * 1000;
    // A shotId-bound verdict can't predate its shell's fate - a planted
    // shell's destroy lands at TTL, not at the painted blast (the
    // srvAt:none + fate-late pairing class). Same horizon the kb stamps
    // use: full shell life, 9s cap.
    const deadline = e.t + 900 + Math.min(ttlMs, 9000) + stallMs;
    if (now > deadline) {
      // Bodyless + carrier-spawned weapons (MRVBomblet, melee, beams)
      // have no shotId-bound shell fate - the client intent is never
      // reborn server-side, so a 'none' verdict can't distinguish a lost
      // intent from "no fate contract exists". Skip those: noise was
      // drowning the real verdicts (wt:29 srvAt:none in every soak).
      if (e.wt !== undefined && !serverSimmed(e.wt)) {dmgEchoes.splice(i, 1); continue;}
      // Victim died inside the stamp→verdict window - the server skips
      // dead targets before any refuse/confirm path can run, so this
      // echo can never prove a miss: unjudgeable, not a complaint.
      const died = victimDiedAt.get(e.victim);
      if (died !== undefined && died >= e.t - 500) {
        parityProbes.echoesVoided = (parityProbes.echoesVoided ?? 0) + 1;
        dmgEchoes.splice(i, 1);
        continue;
      }
      const fate = e.shotId ? shellFates.get(e.shotId) : undefined;
      const detail: Record<string, unknown> = Object.assign({}, {victim: e.victim,dmg: e.dmg}, (e.wt === undefined ? {} : { wt: e.wt }), { shot: e.shotId ?? '?' });
      if (e.at) {detail.at = `${e.at.x.toFixed(0)},${e.at.y.toFixed(0)},${e.at.z.toFixed(0)}`;}
      // Aim staleness: the wire pos of the victim at stamp time vs the
      // point the hit painted - if the victim wasn't actually there, the
      // server legitimately missed no matter where the shell went.
      if (e.vWire && e.at) {
        detail.vWire = `${e.vWire.x.toFixed(0)},${e.vWire.y.toFixed(0)},${e.vWire.z.toFixed(0)}`;
        detail.aimOff = Number(Math.hypot(e.at.x - e.vWire.x, e.at.y - e.vWire.y, e.at.z - e.vWire.z).toFixed(1));
      }
      // Trajectory divergence: the server's detonate point vs the
      // predicted contact - if the shell itself flew differently, the
      // spawn claim/coalescing changed its arc.
      if (fate && e.at) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
        detail.offM = Number(Math.hypot(fate.at.x - e.at.x, fate.at.y - e.at.y, fate.at.z - e.at.z).toFixed(1));
      } else if (fate) {
        detail.srvAt = `${fate.at.x.toFixed(0)},${fate.at.y.toFixed(0)},${fate.at.z.toFixed(0)}`;
      } else {
        detail.srvAt = 'none'; // server shell never detonated - intent died before it ran
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

/** Dump section - the census line leads, recent misses follow
 *  newest-first so a paste shows WHICH predictions died. */
export function parityLines(): string[] {
  const lines: string[] = [];
  const byKind = [...counts.entries()].map(([k, n]): string => {
    const s = stamps.get(k);
    return s ? `${k}=${n}/${s}(${(n / s * 100).toFixed(1)}%)` : `${k}=${n}`;
  }).join(' ');
  lines.push(`parity: misses=${total}${byKind ? ` ${byKind}` : ''}`);
  const td = trajDivStats();
  if (td.n > 0 || parityProbes.trajUnbound) {lines.push(`  shell-traj: n=${td.n} p50=${td.p50}m p95=${td.p95}m max=${td.max}m >8m=${td.over8} unbound=${parityProbes.trajUnbound ?? 0} bounced=${parityProbes.trajBounced ?? 0}`);}
  for (const r of rows.slice(-8).toReversed()) {
    lines.push(`  parity-${r.kind}: ${r.detail}`);
  }
  return lines;
}

// Headless/soak path - __trailDump() merges every registerDiag section,
// so the parity census + trajectory audit land in collectDiag output too.
registerDiag('parity', () => ({
  misses: total,
  parity: parityProbes,
  byKind: Object.fromEntries([...counts.entries()].map(([k, n]) => [k, `${n}/${stamps.get(k) ?? 0}`])),
  // Detail rows - the census hides WHICH prediction died; the ring keeps
  // the last 24 so a headless pull names the outliers (traj/dmg/kb).
  rows: rows.slice(-12).map((r) => `${r.kind} ${r.detail}`),
  trajDiv: trajDivStats(),
}));
