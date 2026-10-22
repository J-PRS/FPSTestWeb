// Deep telemetry — the flight recorder. The counter canaries say THAT a
// class fired; the journal says WHAT the wire carried when it did. Heavy
// for a shipped build (rings alloc + per-message work), so it only arms
// on ?telemetry=deep — every call site is a one-line no-op otherwise.
//
// Consumers: window.__telemetry.dump() (MCP/headless pulls a JSON blob),
// Alt+Q's collectDiag section (ring tails only — a paste shows the last
// corrections/drifts, not the whole 4000-entry buffer).
export const telemetry = {
  enabled: false,
  t0: 0,
  wireIn: [] as { t: number; type: string; sz?: number }[],
  wireOut: [] as { t: number; type: string }[],
  corr: [] as { t: number; err: number; gapMs: number; journal: number; snap: boolean }[],
  drift: [] as { t: number; id: string; dist: number; ageMs: number }[],
  hits: [] as { t: number; shooter: string; target: string; dmg: number; predicted: boolean }[],
};

const RING = 4000;
const push = <T>(ring: T[], e: T): void => { ring.push(e); if (ring.length > RING) {ring.splice(0, ring.length - RING);} };

export function recWireIn(type: string, sz?: number): void {
  if (!telemetry.enabled) {return;}
  push(telemetry.wireIn, { t: performance.now(), type, sz });
}
export function recWireOut(type: string): void {
  if (!telemetry.enabled) {return;}
  push(telemetry.wireOut, { t: performance.now(), type });
}
export function recCorrection(err: number, gapMs: number, journal: number, snap: boolean): void {
  if (!telemetry.enabled) {return;}
  push(telemetry.corr, { t: performance.now(), err: Math.round(err * 100) / 100, gapMs: Math.round(gapMs), journal, snap });
}
export function recDrift(id: string, dist: number, ageMs: number): void {
  if (!telemetry.enabled) {return;}
  push(telemetry.drift, { t: performance.now(), id, dist: Math.round(dist * 10) / 10, ageMs: Math.round(ageMs) });
}
export function recHit(shooter: string, target: string, dmg: number, predicted: boolean): void {
  if (!telemetry.enabled) {return;}
  push(telemetry.hits, { t: performance.now(), shooter, target, dmg, predicted });
}

/** Per-type census over the last `spanMs` of the inbound ring — wire
 *  traffic shape per second without dumping the whole journal. */
export function wireRates(spanMs: number): Record<string, number> {
  const cut = performance.now() - spanMs;
  const out: Record<string, number> = {};
  for (const e of telemetry.wireIn) {if (e.t > cut) {out[e.type] = (out[e.type] ?? 0) + 1;}}
  return out;
}

export function telemetryDump(): Record<string, unknown> {
  return {
    t0: telemetry.t0, t: performance.now(),
    wireIn: telemetry.wireIn, wireOut: telemetry.wireOut,
    corr: telemetry.corr, drift: telemetry.drift, hits: telemetry.hits,
  };
}

/** ?telemetry=deep arms the recorder + installs window.__telemetry —
 *  kept out of main.ts (size-pinned): call sites gate on
 *  telemetry.enabled directly. */
export function armTelemetry(): void {
  telemetry.enabled = new URLSearchParams(window.location.search).get('telemetry') === 'deep';
  telemetry.t0 = performance.now();
  window.__telemetry = { enabled: telemetry.enabled, dump: telemetryDump };
}

// Alt+Q / __trailDump tail — rings bounded in the section, the full
// journal is __telemetry.dump() only.
import { registerDiag } from './fxDiag.js';
registerDiag('telemetry', () => telemetry.enabled ? {
  telemetry: {
    wireIn: telemetry.wireIn.length, wireOut: telemetry.wireOut.length,
    wireRates: wireRates(10_000),
    corr: telemetry.corr.slice(-8), drift: telemetry.drift.slice(-8),
    hits: telemetry.hits.slice(-8),
  },
} : {});
