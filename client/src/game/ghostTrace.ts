// Ghost-epoch trace — samples the three positions a remote body wears at
// once: rendered (interp), wire (last record), ghost (lag-comp epoch the
// server validates against). The ?debug wireframes show them live; this
// ring makes the soak measurable — pairwise divergence percentiles plus
// the worst rows, so "the yellow capsule was way off" becomes a number.
//
// rw  = rendered↔wire — interpolation lag, the delay you see
// wg  = wire↔ghost    — lag-comp projection distance (viewLag of travel)
// rg  = rendered↔ghost — what you see vs what the server judges
// rg >> 0 is the class that makes honest shots whiff visually.

import * as THREE from 'three';
import { registerDiag } from '../core/fxDiag.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';

const SAMPLE_MS = 100;
const MAX_ROWS = 6000;
const scratch = new THREE.Vector3();

interface GhostRow {
  t: number; id: string;
  rw: number; wg: number; rg: number;
  /** Speed of the wire record at sample time — divergence means more at
   *  60m/s than at 5m/s. */
  spd: number;
  /** Interp phase flags at sample time — identifies WHICH mechanism let
   *  rendered diverge from the ghost (DR free-run, converge steer,
   *  extrapolation cap, or plain silence). */
  sim: boolean; conv: boolean; cap: boolean;
  /** Wall-ms since the last server update — separates "buffered interp"
   *  (fresh) from "no wire truth arrived" (stale). */
  silence: number;
}
const rows: GhostRow[] = [];
let nextAt = 0;

export function sampleRemoteGhosts(remotes: Iterable<RemotePlayer>): void {
  const now = performance.now();
  if (now < nextAt) {return;}
  nextAt = now + SAMPLE_MS;
  for (const rp of remotes) {
    if (rp.localDriven || rp.isDead || rp.lastUpdateTime <= 0) {continue;}
    const g = rp.ghostPosition(scratch);
    const w = rp.wirePosition;
    const r = rp.position;
    const rw = Math.hypot(r.x - w.x, r.y - w.y, r.z - w.z);
    const wg = Math.hypot(w.x - g.x, w.y - g.y, w.z - g.z);
    const rg = Math.hypot(r.x - g.x, r.y - g.y, r.z - g.z);
    rows.push({
      t: now, id: rp.playerId, rw, wg, rg,
      spd: Math.hypot(rp.vel.x, rp.vel.y, rp.vel.z),
      sim: rp.isSimulating, conv: rp.interpConverging, cap: rp.interpAtCap,
      silence: Date.now() - rp.lastUpdateTime,
    });
  }
  if (rows.length > MAX_ROWS) {rows.splice(0, rows.length - MAX_ROWS);}
}

function pct(vals: number[], f: number): number {
  if (vals.length === 0) {return 0;}
  const s = vals.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * f))]! * 100) / 100;
}

registerDiag('ghosts', () => {
  const rw = rows.map((r) => r.rw);
  const wg = rows.map((r) => r.wg);
  const rg = rows.map((r) => r.rg);
  const worst = rows.slice().sort((a, b) => b.rg - a.rg).slice(0, 5)
    .map((r) => `${r.id.slice(0, 12)} rg=${r.rg.toFixed(1)} rw=${r.rw.toFixed(1)} wg=${r.wg.toFixed(1)} @${Math.round(r.spd)}m/s ${r.sim ? 'SIM' : ''}${r.conv ? 'CONV' : ''}${r.cap ? 'CAP' : ''} sil=${Math.round(r.silence)}ms`);
  return {
    ghosts: {
      n: rows.length,
      rw: { p50: pct(rw, 0.5), p95: pct(rw, 0.95), max: rw.length > 0 ? Math.max(...rw).toFixed(1) : 0 },
      wg: { p50: pct(wg, 0.5), p95: pct(wg, 0.95), max: wg.length > 0 ? Math.max(...wg).toFixed(1) : 0 },
      rg: { p50: pct(rg, 0.5), p95: pct(rg, 0.95), max: rg.length > 0 ? Math.max(...rg).toFixed(1) : 0 },
      worst,
    },
  };
});
