// NetProbe — the netcode harness. Three jobs:
//   1. Journal: a bounded ring of structured netcode events (corrections
//      with their predicted-vs-authoritative delta, claim verdicts, spawn
//      claim drift) so an Alt+Q dump or the live panel can answer "what
//      did the server disagree with, how far off was I, and why".
//   2. Overlay (Alt+N): a Source-style net_graph — ping/loss/jitter,
//      corrections/min with worst delta, reject census by reason, and
//      the last few raw events.
//   3. Ghosts: on a real correction, red wire sphere at the server's
//      truth + green at our predicted pos for ~3s — the rubberband is
//      literally visible in the world instead of a number in a log.
//
// Everything degrades to silent no-ops until bindStats/attachScene run —
// the probe must never cost a session that never asked for it.

import * as THREE from 'three';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('NetProbe');

const RING_MAX = 256;
const GHOST_TTL_S = 3;

interface NetEvt {
  t: number;
  kind: 'corr' | 'reject' | 'drop' | 'spawn' | 'hash';
  line: string;
}

interface NetStats {
  getPing(): number;
  getPacketLoss(): number;
  getJitter(): number;
}

const events: NetEvt[] = [];
let stats: NetStats | null = null;
let scene: THREE.Scene | null = null;

// Counters
let corrCount = 0;
let corrErrSum = 0;
let corrErrMax = 0;
let corrWindow: number[] = []; // timestamps for corr/min
const rejects = new Map<string, number>();
let spawnDriftMax = 0;
let spawnDriftN = 0;

/** Wire in the telemetry source (NetworkManager). Called once at wire-up. */
export function bindStats(s: NetStats): void { stats = s; }

/** Give the ghost renderer a scene — corrections draw truth vs predicted. */
export function attachScene(s: THREE.Scene): void { scene = s; }

function push(kind: NetEvt['kind'], line: string): void {
  events.push({ t: performance.now(), kind, line });
  if (events.length > RING_MAX) {events.splice(0, events.length - RING_MAX);}
}

// ---- recorders (called by the wire handlers) ----

/** A server correction fired. `err` = metres between our predicted pos
 *  and the authoritative state BEFORE the snap — the rubberband size. */
export function corr(err: number, seq: number, journalLen: number, vel: number, snap: boolean): void {
  const ping = stats?.getPing() ?? -1;
corrCount += 1;
  corrErrSum += err;
  corrErrMax = Math.max(corrErrMax, err);
  corrWindow.push(performance.now());
  const line = `corr#${seq} err=${err.toFixed(2)}m journal=${journalLen} vel=${vel.toFixed(1)}m/s ping=${ping}ms${snap ? ' SNAP' : ' rew+replay'}`;
  push('corr', line);
  // Corrections ≥0.5m already take the snap path — make the delta
  // searchable in the buffer/ship lane, not just panel-visible.
  logger.warn(line);
}

/** Claim verdict from the wire (reject or honest-lag drop). */
export function claim(kind: 'reject' | 'drop', reason: string, weapon: string | undefined, target: string | undefined, ping: number): void {
  const k = reason.split(':').slice(0, 2).join(':');
  rejects.set(`${kind}:${k}`, (rejects.get(`${kind}:${k}`) ?? 0) + 1);
  push(kind, `${kind} ${reason} w=${weapon ?? '?'}${target ? ` →${target}` : ''} ping=${ping}ms`);
}

/** Spawn-claim drift: metres/sec between the velocity claimed to the
 *  server and the velocity the projectile actually flies. Must be ~0 —
 *  any nonzero here means the server replays a different arc than the
 *  one on screen (the 'flight blocked' class of phantom rejects). */
export function spawnDrift(dv: number): void {
spawnDriftN += 1;
  spawnDriftMax = Math.max(spawnDriftMax, dv);
  // The journal is for anomalies — a 0.00 drift row is pure noise and
  // used to flood every Alt+Q's recent-events tail. The summary line
  // (spawnDrift max/N) still counts every sample.
  if (dv >= 0.05) {push('spawn', `spawn claim drift=${dv.toFixed(2)}m/s`);}
  if (dv > 0.5) {logger.error(`spawn claim drifts ${dv.toFixed(2)}m/s from real flight — server arc replay will diverge`);}
}

// ---- Ghosts ----
// Red sphere = server truth, green = where we thought we were. The line
// between them is the snap the player just felt. Only while the panel
// is open — invisible debugging shouldn't cost draw calls.

const ghosts: { objs: THREE.Object3D[]; until: number }[] = [];
const ghostGeo = new THREE.SphereGeometry(0.6, 10, 8);
const ghostMatServer = new THREE.MeshBasicMaterial({ color: 0xFF_44_55, wireframe: true, depthTest: false });
const ghostMatClient = new THREE.MeshBasicMaterial({ color: 0x44_FF_88, wireframe: true, depthTest: false });
const ghostLineMat = new THREE.LineBasicMaterial({ color: 0xFF_CC_44, depthTest: false });

export function corrGhost(server: { x: number; y: number; z: number }, predicted: { x: number; y: number; z: number }): void {
  if (!scene || !panelEl || !ghostOn) {return;}
  const srv = new THREE.Mesh(ghostGeo, ghostMatServer);
  srv.position.set(server.x, server.y, server.z);
  const cli = new THREE.Mesh(ghostGeo, ghostMatClient);
  cli.position.set(predicted.x, predicted.y, predicted.z);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([srv.position, cli.position]),
    ghostLineMat,
  );
  const objs = [srv, cli, line];
  for (const o of objs) { o.renderOrder = 9999; scene.add(o); }
  ghosts.push({ objs, until: performance.now() + GHOST_TTL_S * 1000 });
}

function pruneGhosts(): void {
  const now = performance.now();
  for (let i = ghosts.length - 1; i >= 0; i -= 1) {
    if (ghosts[i]!.until <= now) {
      for (const o of ghosts[i]!.objs) {scene?.remove(o);}
      ghosts.splice(i, 1);
    }
  }
}

// ---- Overlay panel (Alt+N) ----

let panelEl: HTMLDivElement | null = null;
let ghostOn = true;
let refreshTimer = 0;

function corrPerMin(): number {
  const cutoff = performance.now() - 60_000;
  corrWindow = corrWindow.filter((t): boolean => t > cutoff);
  return corrWindow.length;
}

function panelHtml(): string {
  const ping = stats?.getPing() ?? -1;
  const loss = stats?.getPacketLoss() ?? 0;
  const jitter = stats?.getJitter() ?? -1;
  const avg = corrCount ? corrErrSum / corrCount : 0;
  const top = [...rejects.entries()].sort((a, b): number => b[1] - a[1]).slice(0, 5)
    .map(([r, n]): string => `${r} ×${n}`).join('<br>');
  const recent = events.slice(-8).reverse()
    .map((e): string => `<div style="opacity:0.7">${((performance.now() - e.t) / 1000).toFixed(1)}s ${e.line}</div>`).join('');
  return `<b>NET</b> ping ${ping}ms · loss ${loss}% · jitter ${jitter}ms<br>` +
    `corr ${corrPerMin()}/min · max ${corrErrMax.toFixed(1)}m · avg ${avg.toFixed(2)}m<br>` +
    `spawnDrift ${spawnDriftMax.toFixed(2)}m/s over ${spawnDriftN}<br>${ 
    top ? `<b>claims</b><br>${top}<br>` : '' 
    }${recent ? `<b>recent</b>${recent}` : '<i>no events yet</i>'}`;
}

function togglePanel(): void {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
    clearInterval(refreshTimer);
    for (const g of ghosts.splice(0)) {for (const o of g.objs) {scene?.remove(o);}}
    return;
  }
  panelEl = document.createElement('div');
  panelEl.id = 'netprobe';
  panelEl.style.cssText = 'position:fixed;top:12px;left:12px;z-index:99998;padding:8px 12px;background:rgba(8,12,16,0.88);border:1px solid rgba(120,200,255,0.35);color:#cfe8ff;font:12px/1.45 monospace;border-radius:6px;pointer-events:auto;max-width:460px;';
  const toggle = document.createElement('label');
  toggle.style.cssText = 'display:block;margin-top:6px;cursor:pointer;opacity:0.85';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = ghostOn;
  cb.addEventListener('change', (): void => { ghostOn = cb.checked; });
  toggle.append(cb, ' ghost corrections (red=server, green=predicted)');
  const body = document.createElement('div');
  body.id = 'netprobe-body';
  panelEl.append(body, toggle);
  document.body.append(panelEl);
  const refresh = (): void => {
    if (body.isConnected) { body.innerHTML = panelHtml(); pruneGhosts(); }
  };
  refresh();
  refreshTimer = setInterval(refresh, 250) as unknown as number;
}

let armed = false;
/** Install the Alt+N toggle + register the Alt+Q dump section. Idempotent. */
export function initNetProbe(): void {
  if (armed || typeof window === 'undefined') {return;}
  armed = true;
  document.addEventListener('keydown', (e): void => {
    if (e.altKey && e.code === 'KeyN') { e.preventDefault(); togglePanel(); }
  });
}

/** Alt+Q dump section — the correction/claim census in the report. */
export function diagLines(): string[] {
  const avg = corrCount ? corrErrSum / corrCount : 0;
  const out = [`netprobe: corr=${corrCount} (${corrPerMin()}/min) max=${corrErrMax.toFixed(1)}m avg=${avg.toFixed(2)}m spawnDrift=${spawnDriftMax.toFixed(2)}m/s/${spawnDriftN}`];
  if (rejects.size > 0) {
    out.push(`  claims: ${[...rejects.entries()].map(([r, n]): string => `${r} ×${n}`).join(' | ')}`);
  }
  for (const e of events.slice(-12)) {
    out.push(`  -${((performance.now() - e.t) / 1000).toFixed(1)}s ${e.line}`);
  }
  return out;
}
