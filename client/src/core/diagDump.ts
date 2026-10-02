// Alt+Q diagnostics dump — the clipboard-ready "what's on screen / what
// does the server think" report. Lives apart from stateDebug.ts: that
// file owns snapshot desync diffing; this one owns dump formatting plus
// the rolling battle log sections read from.

import { aimProbe } from './aimProbe.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { StateDebugContext } from './stateDebug.js';

// Rolling battle log — every kill the wire reported, newest last.
// Capped so a long session doesn't grow it unboundedly.
const battleLog: string[] = [];
const BATTLE_LOG_MAX = 40;
const killName = (id: string) => id.replace(/^bot:/, '');

/** Called by the kill handlers — "shooter killed target with weapon"
 *  lines for the dump's battle-log section. */
export function noteKill(shooterId: string, targetId: string, weapon?: number): void {
  const w = weapon !== undefined && WeaponType[weapon] ? ` with ${WeaponType[weapon]}` : '';
  battleLog.push(`${killName(shooterId)} killed ${killName(targetId)}${w}`);
  if (battleLog.length > BATTLE_LOG_MAX) battleLog.splice(0, battleLog.length - BATTLE_LOG_MAX);
}

export const fmt = (v: { x: number; y: number; z: number }) =>
  `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;

/** Chrome-only JS heap gauge — absent in Firefox/Safari, so the line
 *  degrades to nothing instead of lying. */
function heapLine(): string {
  const m = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return m ? ` heap ${(m.usedJSHeapSize / 1048576).toFixed(0)}/${(m.jsHeapSizeLimit / 1048576).toFixed(0)}MB` : '';
}

export function diagLines(ctx: StateDebugContext): string[] {
  const nm = ctx.networkManager;
  const p = ctx.getPlayer();
  const wire = nm.getPlayers();
  const lines: string[] = [
    `localId: ${nm.getLocalPlayerId()}`,
    `connected: ${nm.isConnected()} tier: ${nm.getTransportTier() ?? '-'} ping: ${nm.getPing()}ms loss: ${nm.getPacketLoss()}% jitter: ${nm.getJitter()}ms`,
    `net: up ${(nm.bandwidth().up / 1024).toFixed(1)}KB/s down ${(nm.bandwidth().down / 1024).toFixed(1)}KB/s${heapLine()}`,
    `local: dead=${p.isDead} hp=${p.health} pos=${fmt(p.pos)} vel=${fmt(p.vel)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)} onGround=${p.onGround}`,
    `lastSentPos: ${fmt(ctx.getLastSentPos())}`,
  ];
  pushWorld(lines, ctx.world);
  pushAimProbe(lines, ctx);
  lines.push(`remotes: ${ctx.remotePlayers.size} rendered / ${wire.size} known`);
  for (const [id, ps] of wire) {
    const rp = ctx.remotePlayers.get(id);
    const renderD = rp ? Math.hypot(rp.position.x - ps.position.x, rp.position.y - ps.position.y, rp.position.z - ps.position.z) : -1;
    lines.push(`  wire ${id.slice(0, 20)} team=${ps.team ?? '-'} dead=${ps.isDead} hp=${ps.health} ping=${ps.ping ?? '?'} pos=${fmt(ps.position)}${rp ? ` renderΔ=${renderD.toFixed(1)}m` : ' NOT-RENDERED'}`);
  }
  // Rendered but absent from the wire roster — local bots, dummies,
  // stale ghosts the roster never told us about.
  for (const [id, rp] of ctx.remotePlayers) {
    if (wire.has(id)) continue;
    const team = (rp as { team?: string }).team;
    lines.push(`  local ${id.slice(0, 20)} team=${team ?? '-'} dead=${rp.isDead} pos=${fmt(rp.position)}`);
  }
  pushBots(lines, ctx);
  lines.push(
    `projectiles: ${ctx.projectiles.length} live`,
    `uptime: ${(performance.now() / 1000).toFixed(0)}s`,
  );
  pushTrailCensus(lines, ctx);
  pushProjectiles(lines, ctx);
  if (battleLog.length) {
    lines.push('battleLog:');
    for (const k of battleLog.slice(-15)) lines.push(`  ${k}`);
  }
  // Sim lab: the scenario's own rows (hp/fires/lanes) — registered by
  // labView only while the lab is actually open.
  const ld = (window as { __labDump?: () => [string, [string, string][]] | undefined }).__labDump?.();
  if (ld) {
    lines.push(`lab: ${ld[0]}`);
    for (const [k, v] of ld[1]) lines.push(`  ${k}: ${v}`);
  }
  return lines;
}

// Per-projectile row — pairs a dead trail with the shell that owns it.
// Ribbon health flags per lane: '!' stopped, 'L' lit on screen,
// '~N' pushes starved by the near-zero-velocity gate — a shell pushing
// every frame that still has count<2 is the silent no-trail case.
function pushProjectiles(lines: string[], ctx: StateDebugContext): void {
  let ribbonWarns = 0;
  for (const pr of ctx.projectiles) {
    const d = pr.dbg();
    const rib = d.ribbons.map(r => `${r.slot}:${r.count}${r.stopped ? '!' : ''}${r.lit ? 'L' : ''}${r.starved ? `~${r.starved}` : ''}`).join(',');
    if (d.ribbons.some(r => r.count < 2 && r.starved > 10)) ribbonWarns++;
    lines.push(`  proj ${pr.config.name} age=${pr.age.toFixed(2)}${pr.exploded ? ' EX' : ''} q=${JSON.stringify(d.trail)} rib=[${rib}]`);
  }
  if (ribbonWarns) lines.push(`ribbonWarns: ${ribbonWarns} projectiles emit pushes but have NO ribbon samples`);
}

// Crosshair probe near the top — the point of the dump is usually "what
// is THAT thing", so the answer shouldn't sit under the censuses.
function pushAimProbe(lines: string[], ctx: StateDebugContext): void {
  const aimScene = ctx.getScene?.(), aimCam = ctx.getCamera?.();
  if (!aimScene || !aimCam) return;
  try {
    const hits = aimProbe(aimScene, aimCam);
    lines.push(`aim: ${hits.length ? '' : '(no tagged object under crosshair)'}`);
    for (const h of hits) lines.push(`  ${h}`);
  } catch (e) {
    lines.push(`aim: probe failed ${(e as Error).message}`);
  }
}

// Sections self-register via registerDiag() in the owning modules —
// every field optional so a module that never loaded degrades to a
// missing line, not a thrown dump.
interface TrailDump {
  stats?: Record<string, number>;
  pools?: Record<string, unknown>;
  trails?: Record<string, unknown>[];
  ribbons?: Record<string, unknown>[];
  ribbonBatch?: unknown;
  ribbonOrphans?: { count: number; slots: number[]; rows: Record<string, unknown>[] };
  litAudit?: { lit: number; unowned: number[] };
  reapedLit?: number;
  inst?: unknown;
  swarm?: unknown;
  fx?: unknown;
  geoNaN?: Record<string, unknown>[];
  ballDots?: Record<string, unknown>[];
  balls?: { viewPos?: string; rows?: Record<string, unknown>[] };
}

// Row dumps are per-live-entity — bound them or a busy fight turns the
// paste into a novel. Totals stay exact; rows beyond the cap get an
// omitted count.
function pushCapped(lines: string[], label: string, arr: Record<string, unknown>[] | undefined, cap = 24): void {
  const rows = arr ?? [];
  for (const r of rows.slice(0, cap)) lines.push(`  ${label} ${JSON.stringify(r)}`);
  if (rows.length > cap) lines.push(`  … ${rows.length - cap} more ${label}s`);
}

// Trail census — dead-trail bugs need attached/particles/slot per live
// trail, not just the projectile count.
function pushTrailCensus(lines: string[], ctx: StateDebugContext): void {
  const td = window.__trailDump?.() as TrailDump | undefined;
  if (!td) return;
  if (td.stats) lines.push(`trailStats: ${Object.entries(td.stats).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (td.pools) lines.push(`pools: ${JSON.stringify(td.pools)}`);
  pushCapped(lines, 'trail', td.trails);
  lines.push(`ribbons: ${td.ribbons?.length ?? 0} live ${JSON.stringify(td.ribbonBatch ?? null)}`);
  // Position-tagged rows — a frozen streak on screen maps to a slot by its
  // head/mid coords; sorted by fullness so the longest streaks lead.
  const rs = (td.ribbons ?? []).toSorted((a, b) => ((b.count as number) ?? 0) - ((a.count as number) ?? 0)).slice(0, 16);
  for (const r of rs) lines.push(`  rib ${JSON.stringify(r)}`);
  const orphans = td.ribbonOrphans;
  if (orphans && orphans.count > 0) {
    lines.push(`ribbonOrphans: ${orphans.count} (leaked slots: ${orphans.slots.length})`);
    pushCapped(lines, 'orphan', orphans.rows);
  } else {
    lines.push('ribbonOrphans: 0');
  }
  pushTrailExtras(lines, td, ctx);
}

// The extras half of the trail census: GPU-buffer audits (lit-but-unowned
// slots — frozen streaks no RibbonTrail object owns, reapedLit counts the
// ones the sweeper already blacked out), instancing/species pool inventory,
// and the oldest-shell line that surfaces the next immortal early.
function pushTrailExtras(lines: string[], td: TrailDump, ctx: StateDebugContext): void {
  if (td.litAudit) {
    const unowned = td.litAudit.unowned;
    lines.push(`litAudit: lit=${td.litAudit.lit} unowned=${unowned.length}${unowned.length ? ' slots=[' + unowned.slice(0, 12).join(',') + (unowned.length > 12 ? ',…' : '') + ']' : ''} reaped=${td.reapedLit ?? 0}`);
  }
  if (td.inst) lines.push(`instPools: ${JSON.stringify(td.inst)}`);
  if (td.swarm) lines.push(`swarm: ${JSON.stringify(td.swarm)}`);
  if (td.fx) lines.push(`fx: ${JSON.stringify(td.fx)}`);
  // NaN-geometry sniffer rows — owner path + attr signature, so the next
  // "radius is NaN" console burst already names its source.
  if (td.geoNaN?.length) lines.push(`geoNaN: ${td.geoNaN.map(h => `${h.uuid}@${h.at}s ${h.owner}${h.tag ? `<${h.tag}>` : ''}`).join(' | ')}`);
  pushBallCensus(lines, td);
  pushShellAudit(lines, ctx);
}

// Projectile audit — the oldest-shell line surfaces the next immortal
// early; the offWorld count catches shells that escaped the sane-bounds
// box (a garbage trail census usually traces back to one of these).
function pushShellAudit(lines: string[], ctx: StateDebugContext): void {
  const aged = ctx.projectiles.toSorted((a, b) => b.age - a.age).slice(0, 5);
  if (aged.length) {
    lines.push(`oldest: ${aged.map(pr => `${pr.config.name}@${pr.age.toFixed(1)}s(${pr.pos.x.toFixed(0)},${pr.pos.y.toFixed(0)},${pr.pos.z.toFixed(0)})`).join(' ')}`);
  }
  let offWorld = 0;
  for (const pr of ctx.projectiles) {
    if (pr.pos.y < -500 || Math.abs(pr.pos.x) > 4000 || Math.abs(pr.pos.z) > 4000) offWorld++;
  }
  if (offWorld) lines.push(`offWorld: ${offWorld} projectiles outside sane bounds`);
}

// Ball trail census — emit gates (speed >0.7, cam <200m) vs outputs
// (live dots, ribbon samples). "spd=0 dots=0" everywhere = the shared
// starvation case; "dots>0 but no sparkle" = a render/batch break.
function pushBallCensus(lines: string[], td: TrailDump): void {
  if (td.ballDots) lines.push(`ballDots: ${JSON.stringify(td.ballDots)}`);
  if (td.balls) {
    lines.push(`balls: ${td.balls.rows?.length ?? 0} live viewPos=${td.balls.viewPos ?? '?'}`);
    for (const r of td.balls.rows ?? []) lines.push(`  ball ${JSON.stringify(r)}`);
  }
}

function pushWorld(lines: string[], w: StateDebugContext['world']): void {
  if (!w) return;
  const clock = w.matchEndsAt ? ` endsIn=${Math.max(0, Math.ceil((w.matchEndsAt - Date.now()) / 1000))}s` : '';
  lines.push(`mode: ${w.mode ?? '(none)'} localTeam: ${w.localTeam ?? '-'}${w.playbackMode ? ' PLAYBACK' : ''}${clock}`);
  if (w.teamScores) lines.push(`teamScores: alpha=${w.teamScores.alpha} bravo=${w.teamScores.bravo}`);
  if (w.ffaScores?.size) lines.push(`ffaScores: ${[...w.ffaScores.entries()].map(([id, s]) => `${id.replace('bot:', '')}=${s}`).join(' ')}`);
}

function pushBots(lines: string[], ctx: StateDebugContext): void {
  const tb = ctx.teamBots?.();
  if (!tb) return;
  const alive = tb.bots.filter(b => !b.isDead).length;
  lines.push(`teamBots: ${alive}/${tb.bots.length} alive over=${tb.over ?? '-'} score=${tb.scores.alpha}:${tb.scores.bravo} localTeam=${tb.teamOf.get('local') ?? '-'}`);
  for (const b of tb.bots) {
    lines.push(`  bot ${b.playerId.replace('bot:', '')} team=${b.team} dead=${b.isDead} hp=${b.botHp ?? '?'} sheep=${(b as { sheep?: number }).sheep ?? 0} pos=${fmt(b.position)}`);
  }
}
