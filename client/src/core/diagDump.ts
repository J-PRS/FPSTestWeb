// Alt+Q diagnostics dump - the clipboard-ready "what's on screen / what
// does the server think" report. Lives apart from stateDebug.ts: that
// file owns snapshot desync diffing; this one owns dump formatting plus
// the rolling battle log sections read from.

import { aimProbe } from './aimProbe.js';
import { terrainDivLine } from '../world/terrain.js';
import { staleLine } from './staleFiles.js';
import { deployStamp } from './deployWatch.js';
import { serverStamp } from '../networking/wireIn.js';
import { diagLines as netProbeLines } from '../debug/netProbe.js';
import { parityLines } from '../game/parity.js';
import { longestGaps } from '../effects/RibbonTrail.js';
import { topChains, topSpans } from '../effects/trailBatch.js';
import { depGaps } from '../effects/vfxRuntime.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { StateDebugContext } from './stateDebug.js';

// Rolling battle log - every kill the wire reported, newest last.
// Capped so a long session doesn't grow it unboundedly.
const battleLog: string[] = [];
const BATTLE_LOG_MAX = 40;
const killName = (id: string): string => id.replace(/^bot:/, '');

/** Called by the kill handlers - "shooter killed target with weapon"
 *  lines for the dump's battle-log section. */
export function noteKill(shooterId: string, targetId: string, weapon?: number): void {
  const w = weapon !== undefined && WeaponType[weapon] ? ` with ${WeaponType[weapon]}` : '';
  battleLog.push(`${killName(shooterId)} killed ${killName(targetId)}${w}`);
  if (battleLog.length > BATTLE_LOG_MAX) {battleLog.splice(0, battleLog.length - BATTLE_LOG_MAX);}
}

export const fmt = (v: { x: number; y: number; z: number }): string =>
  `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;

/** Chrome-only JS heap gauge - absent in Firefox/Safari, so the line
 *  degrades to nothing instead of lying. */
function heapLine(): string {
  const m = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return m ? ` heap ${(m.usedJSHeapSize / 1_048_576).toFixed(0)}/${(m.jsHeapSizeLimit / 1_048_576).toFixed(0)}MB` : '';
}

function pushBots(lines: string[], ctx: StateDebugContext): void {
  const tb = ctx.teamBots?.();
  if (!tb) {return;}
  const alive = tb.bots.filter((b): boolean => !b.isDead).length;
  lines.push(`teamBots: ${alive}/${tb.bots.length} alive over=${tb.over ?? '-'} score=${tb.scores.alpha}:${tb.scores.bravo} localTeam=${tb.teamOf.get('local') ?? '-'}`);
  for (const b of tb.bots) {
    lines.push(`  bot ${b.playerId.replace('bot:', '')} team=${b.team} dead=${b.isDead} hp=${b.botHp ?? '?'} sheep=${(b as { sheep?: number }).sheep ?? 0} pos=${fmt(b.position)}`);
  }
}



function pushWorld(lines: string[], w: StateDebugContext['world']): void {
  if (!w) {return;}
  const clock = w.matchEndsAt ? ` endsIn=${Math.max(0, Math.ceil((w.matchEndsAt - Date.now()) / 1000))}s` : '';
  lines.push(`mode: ${w.mode ?? '(none)'} localTeam: ${w.localTeam ?? '-'}${w.playbackMode ? ' PLAYBACK' : ''}${clock}`);
  if (w.teamScores) {lines.push(`teamScores: alpha=${w.teamScores.alpha} bravo=${w.teamScores.bravo}`);}
  if (w.ffaScores?.size) {lines.push(`ffaScores: ${[...w.ffaScores.entries()].map(([id, s]): string => `${id.replace('bot:', '')}=${s}`).join(' ')}`);}
}



// Trail census - dead-trail bugs need attached/particles/slot per live
// trail, not just the projectile count.
function pushTrailCensus(lines: string[], ctx: StateDebugContext): void {
  const td = window.__trailDump?.() as TrailDump | undefined;
  if (!td) {return;}
  if (td.stats) {lines.push(`trailStats: ${Object.entries(td.stats).map(([k, v]): string => `${k}=${v}`).join(' ')}`);}
  if (td.pools) {lines.push(`pools: ${JSON.stringify(td.pools)}`);}
  pushCapped(lines, 'trail', td.trails, 24, TRAIL_ROW_DEF);
  lines.push(`ribbons: ${td.ribbons?.length ?? 0} live ${JSON.stringify(td.ribbonBatch ?? null)}`);
  const gaps = longestGaps();
  if (gaps.length > 0) {lines.push(`  topGaps: ${gaps.map((g): string => `${g.gapM.toFixed(1)}m@${g.tag}#${g.slot}`).join(' ')}`);}
  const spans = topSpans();
  if (spans.length > 0) {lines.push(`  topSpans: ${spans.map((g): string => `${g.gapM.toFixed(1)}m@${g.tag}#${g.slot}`).join(' ')}`);}
  const deps = depGaps();
  if (deps.length > 0) {lines.push(`  topDep: ${deps.map((g): string => `${g.gapM.toFixed(1)}m@${g.name}`).join(' ')}`);}
  // Total lit chain per slot - the "line of legal segments" a per-segment
  // scan can't see. A stale tail reads as a world-long chain.
  const chains = topChains(5);
  if (chains.length > 0) {lines.push(`  topChain: ${chains.map((c): string => `${c.lenM.toFixed(0)}m@${c.tag}#${c.slot}`).join(' ')}`);}
  // Position-tagged rows - a frozen streak on screen maps to a slot by its
  // head/mid coords; sorted by fullness so the longest streaks lead.
  const rs = (td.ribbons ?? []).toSorted((a, b): number => ((b.count as number) ?? 0) - ((a.count as number) ?? 0)).slice(0, 16);
  for (const r of rs) {lines.push(`  rib ${JSON.stringify(slim(r, RIB_ROW_DEF))}`);}
  const orphans = td.ribbonOrphans;
  if (orphans && orphans.count > 0) {
    lines.push(`ribbonOrphans: ${orphans.count} (leaked slots: ${orphans.slots.length})`);
    pushCapped(lines, 'orphan', orphans.rows);
  } else {
    lines.push('ribbonOrphans: 0');
  }
  pushTrailExtras(lines, td, ctx);
}



// Crosshair probe near the top - the point of the dump is usually "what
// is THAT thing", so the answer shouldn't sit under the censuses.
function pushAimProbe(lines: string[], ctx: StateDebugContext): void {
  const aimScene = ctx.getScene?.(), aimCam = ctx.getCamera?.();
  if (!aimScene || !aimCam) {return;}
  try {
    const hits = aimProbe(aimScene, aimCam);
    lines.push(`aim: ${hits.length > 0 ? '' : '(no tagged object under crosshair)'}`);
    for (const h of hits) {lines.push(`  ${h}`);}
  } catch (error) {
    lines.push(`aim: probe failed ${(error as Error).message}`);
  }
}



// Frame-cost section - window.__perf carries the per-phase EMA table
// (gameLoop marks sim/balls/species/proj/fx/hud/render) plus draw calls
// and the GPU timer. The watchdog log ships the same snapshot on
// sustained <40fps; Alt+Q is the on-demand version. Unknown phases are
// printed as-is so new marks never need wiring here.
function pushPerf(lines: string[]): void {
  const pd = window.__perf?.();
  if (!pd) {return;}
  const {gpu, draws, trisK} = pd as Record<string, number>;
  const rest = ((((Object.assign({}, pd))))) as Record<string, number>;
  delete rest.gpu; delete rest.draws; delete rest.trisK;
  const phasePairs = Object.entries(rest)
    .filter(([k, v]): boolean => !k.startsWith('max:') && !k.startsWith('w:') && k !== 'frame' && typeof v === 'number')
    .map(([k, v]): string => `${k}=${v}`);
  // budget stats arrive as {perFrame,worstItemMs,backlog} objects -
  // flatten to k:field so they survive the number-only filter above.
  for (const [k, v] of Object.entries(pd)) {
    if (typeof v === 'object' && v) {
      phasePairs.push(...Object.entries(v as Record<string, number>).map(([f, n]): string => `${k}.${f}=${n}`));
    }
  }
  lines.push(`perf: frame=${rest['frame']}ms gpu=${gpu?.toFixed(1) ?? '?'}ms draws=${draws} tris=${trisK}k`);
  lines.push(`  ${phasePairs.join(' ')}`);
  const maxPairs = Object.entries(rest).filter(([k]): boolean => k.startsWith('max:'));
  if (maxPairs.length > 0) {
    lines.push(`  spikes: ${maxPairs.map(([k, v]): string => `${k.slice(4)}=${v}`).join(' ')}`);
  }
  // Worst frame in the last ~5s with its own phase split - catches the
  // transient dips the EMA row smooths away.
  const wPairs = Object.entries(rest).filter(([k]): boolean => k.startsWith('w:'));
  if (wPairs.length > 0) {
    lines.push(`  worst: ${wPairs.map(([k, v]): string => `${k.slice(2)}=${v}`).join(' ')}`);
  }
}



// Render pipeline census - pixel modes/AA live in settings + closure
// state, so the renderer self-registers __renderDump rather than the
// dump reaching in. buffer vs canvas size exposes the low-res demote
// case (mid-chain pass output landing below display res).
function pushRender(lines: string[]): void {
  const rd = window.__renderDump?.();
  if (!rd) {return;}
  const pm = ['RAW', 'SMOOTH', 'BAYER', 'ATKINSON'];
  lines.push(`render: pmode=${pm[rd['pmodeEff'] as number] ?? rd['pmodeEff']} (pick ${pm[rd['pmode'] as number]}) pscale=${rd['pscale']} res=${(rd['resScale'] as number).toFixed(2)}`);
  lines.push(`  aa=${rd['aaEff']} (pick ${rd['aa']}) msaa=${rd['msaa']} bloom=${rd['bloom']} postpro=${rd['postpro']} composer=${rd['composerOn']}`);
  lines.push(`  buffer=${rd['buffer']} canvas=${rd['canvas']} tone=${rd['toneMapping']} exp=${rd['exposure']}`);
  lines.push(`  passes: ${(rd['passes'] as string[]).join(' ')}`);
}



// Per-projectile row - pairs a dead trail with the shell that owns it.
// Ribbon health flags per lane: '!' stopped, 'L' lit on screen,
// '~N' pushes starved by the near-zero-velocity gate - a shell pushing
// every frame that still has count<2 is the silent no-trail case.
function pushProjectiles(lines: string[], ctx: StateDebugContext): void {
  let ribbonWarns = 0;
  for (const pr of ctx.projectiles) {
    const d = pr.dbg();
    const rib = d.ribbons.map((r): string => `${r.slot}:${r.count}${r.stopped ? '!' : ''}${r.lit ? 'L' : ''}${r.starved ? `~${r.starved}` : ''}`).join(',');
    if (d.ribbons.some((r): boolean => r.count < 2 && r.starved > 10)) {ribbonWarns += 1;}
    lines.push(`  proj ${pr.config.name} age=${pr.age.toFixed(2)}${pr.exploded ? ' EX' : ''} q=${JSON.stringify(d.trail)} rib=[${rib}]`);
  }
  if (ribbonWarns) {lines.push(`ribbonWarns: ${ribbonWarns} projectiles emit pushes but have NO ribbon samples`);}
}



export function diagLines(ctx: StateDebugContext, verbose = false): string[] {
  const nm = ctx.networkManager;
  const p = ctx.getPlayer();
  const wire = nm.getPlayers();
  const lines: string[] = [
    `localId: ${nm.getLocalPlayerId()}`,
    `connected: ${nm.isConnected()} tier: ${nm.getTransportTier() ?? '-'} ping: ${nm.getPing()}ms srvPing: ${nm.serverPingMs == null ? '?' : `${Math.round(nm.serverPingMs)}ms`}${nm.srvAsymN > 0 ? ` asym: ${Math.round(nm.srvAsymMs)}ms(n=${nm.srvAsymN})` : ''} loss: ${nm.getPacketLoss()}% jitter: ${nm.getJitter()}ms${nm.netProbe ? ` lag: ${Math.round(nm.netProbe.lagMs)}ms coal: ${nm.netProbe.coalesced}${nm.netProbe.drainMsMax ? ` drainMax: ${Math.round(nm.netProbe.drainMsMax)}ms` : ''}` : ''}`,
    `net: up ${(nm.bandwidth().up / 1024).toFixed(1)}KB/s down ${(nm.bandwidth().down / 1024).toFixed(1)}KB/s${nm.handlerThrows ? ` throws:${nm.handlerThrows}` : ''}${heapLine()}`,
    `local: dead=${p.isDead} hp=${p.health} pos=${fmt(p.pos)} vel=${fmt(p.vel)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)} onGround=${p.onGround}`,
    `lastSentPos: ${fmt(ctx.getLastSentPos())}`,
  ];
  // Viewmodel row — "where's my gun": group hidden = the gameLoop gate
  // (dead/3p/spectate/orbit), mesh hidden = the switch envelope never
  // armed a weapon (the igun rung-0 same-slot case).
  const vm = ctx.viewModel;
  if (vm) {
    const shown = [...vm.weapons.entries()].filter(([, g]): boolean => g.visible).map(([i]): string => WeaponType[i] ?? String(i));
    lines.push(`vm: group=${vm.group.visible ? 'vis' : 'HIDDEN'} active=${WeaponType[vm.activeWeapon] ?? vm.activeWeapon} shown=[${shown.join(',') || 'none'}]`);
  }
  // Collider-vs-drawn-surface divergence around the player - the F1
  // overlay's numbers. Chord undercut reads as a positive mean bias.
  const td = terrainDivLine();
  if (td) {lines.push(td);}
  pushWorld(lines, ctx.world);
  if (verbose) {pushRender(lines);}
  pushPerf(lines);
  pushAimProbe(lines, ctx);
  // Netcode census - corrections/claim verdicts answer "why did it
  // rubberband / why didn't that hit land" before the row dumps.
  lines.push(...netProbeLines());
  // Prediction-parity ledger - misses where wire truth disagreed with a
  // local prediction (blast echoes, pickup rests, unprompted shoves).
  lines.push(...parityLines());
  lines.push(`remotes: ${ctx.remotePlayers.size} rendered / ${wire.size} known`);
  for (const [id, ps] of wire) {
    const rp = ctx.remotePlayers.get(id);
    const renderD = rp ? Math.hypot(rp.position.x - ps.position.x, rp.position.y - ps.position.y, rp.position.z - ps.position.z) : -1;
    // terrΔ = wire feet vs the drawn terrain surface - negative past
    // ~-0.5m means the wire is holding the body under the visible ground
    // (server-side dip; the render lift in remoteAnim covers the rest).
    const terrD = rp?.terrain ? (ps.position.y - rp.eyeOff) - rp.terrain.getRenderedHeight(ps.position.x, ps.position.z) : Number.NaN;
    lines.push(`  wire ${id.slice(0, 20)} team=${ps.team ?? '-'} dead=${ps.isDead} hp=${ps.health} ping=${ps.ping ?? '?'} pos=${fmt(ps.position)}${rp ? ` renderΔ=${renderD.toFixed(1)}m at=${fmt(rp.position)} terrΔ=${Number.isFinite(terrD) ? `${terrD.toFixed(1)}m` : '?'} sim=${rp.isSimulating}${rp.isDead ? ` scale=${rp.scale.toFixed(2)}${rp.staleHidden ? ' STALE' : ''}${rp.frustumHidden ? ' FRUSTUM' : ''}` : ''}` : ' NOT-RENDERED'}`);
  }
  // Rendered but absent from the wire roster - local bots, dummies,
  // stale ghosts the roster never told us about.
  for (const [id, rp] of ctx.remotePlayers) {
    if (wire.has(id)) {continue;}
    const {team} = (rp as { team?: string });
    lines.push(`  local ${id.slice(0, 20)} team=${team ?? '-'} dead=${rp.isDead} pos=${fmt(rp.position)}${rp.isDead ? ` scale=${rp.scale.toFixed(2)}${rp.staleHidden ? ' STALE' : ''}` : ''}`);
  }
  if (verbose) {pushBots(lines, ctx);}
  lines.push(
    `projectiles: ${ctx.projectiles.length} live`,
    `uptime: ${(performance.now() / 1000).toFixed(0)}s`,
    `deploy: ${deployStamp()} · server v${serverStamp.version}${serverStamp.build === '?' ? '' : ` (${serverStamp.build})`}`,
    staleLine(),
  );
  // Verbose census - trail/ball/proj/shell row dumps, pool inventories,
  // GPU-slot audits. Actionable when hunting a specific render bug, pure
  // noise for a netcode paste - Ctrl+Alt+Q brings them back.
  if (verbose) {
    pushTrailCensus(lines, ctx);
    pushProjectiles(lines, ctx);
  } else {
    lines.push('verbose: Ctrl+Alt+Q for the full census (trails/pools/projectiles/bots)');
  }
  if (battleLog.length > 0) {
    lines.push('battleLog:');
    for (const k of battleLog.slice(-15)) {lines.push(`  ${k}`);}
  }
  // Sim lab: the scenario's own rows (hp/fires/lanes) - registered by
  // labView only while the lab is actually open.
  const ld = (window as { __labDump?: () => [string, [string, string][]] | undefined }).__labDump?.();
  if (ld) {
    lines.push(`lab: ${ld[0]}`);
    for (const [k, v] of ld[1]) {lines.push(`  ${k}: ${v}`);}
  }
  // Locomotion split per remote (HA/A/S/W/ST/I) - registered by
  // game/remotes.ts; absent until the first remote accrues a bucket.
  const ad = (window as { __aswDump?: () => string[] }).__aswDump?.();
  if (ad?.length) {lines.push('asw (HA/A/S/W/ST/I % of life):', ...ad);}
  return lines;
}

// Sections self-register via registerDiag() in the owning modules -
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

// Default-value suppression - rows repeat ~10 fields that are always the
// same (attached:true, stopped:false, starved:0 …), so a paste is 90%
// boilerplate and the anomaly hides in it. Fields drop ONLY when they
// equal the default; anything odd survives verbatim.
function slim(r: Record<string, unknown>, def?: Record<string, unknown>): Record<string, unknown> {
  if (!def) {return r;}
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k in def && v === def[k]) {continue;}
    o[k] = v;
  }
  return o;
}



// Row dumps are per-live-entity - bound them or a busy fight turns the
// paste into a novel. Totals stay exact; rows beyond the cap get an
// omitted count.
function pushCapped(lines: string[], label: string, arr: Record<string, unknown>[] | undefined, cap = 24, def?: Record<string, unknown>): void {
  const rows = arr ?? [];
  for (const r of rows.slice(0, cap)) {lines.push(`  ${label} ${JSON.stringify(slim(r, def))}`);}
  if (rows.length > cap) {lines.push(`  … ${rows.length - cap} more ${label}s`);}
}

// Per-section defaults - chosen so the *interesting* state always prints.
const TRAIL_ROW_DEF = { attached: true, paused: false, waiting: 0, ended: false, loop: true, emVis: true, emRoot: 'Scene', emScale: 1, inPool: false, hasPs: true };
const RIB_ROW_DEF = { pushed: 0, stopped: false, bb: true, lit: false, starved: 0 };
const BALL_ROW_DEF = { net: true };
const BALL_RIB_DEF = { stopped: false, lit: false, starved: 0 };
const BALL_DOTS_DEF = { timer: 0, lastLive: 0 };

// The extras half of the trail census: GPU-buffer audits (lit-but-unowned
// slots - frozen streaks no RibbonTrail object owns, reapedLit counts the
// ones the sweeper already blacked out), instancing/species pool inventory,
// and the oldest-shell line that surfaces the next immortal early.
function pushTrailExtras(lines: string[], td: TrailDump, ctx: StateDebugContext): void {
  if (td.litAudit) {
    const {unowned} = td.litAudit;
    lines.push(`litAudit: lit=${td.litAudit.lit} unowned=${unowned.length}${unowned.length > 0 ? ` slots=[${  unowned.slice(0, 12).join(',')  }${unowned.length > 12 ? ',…' : ''  }]` : ''} reaped=${td.reapedLit ?? 0}`);
  }
  if (td.inst) {lines.push(`instPools: ${JSON.stringify(td.inst)}`);}
  if (td.swarm) {lines.push(`swarm: ${JSON.stringify(td.swarm)}`);}
  if (td.fx) {lines.push(`fx: ${JSON.stringify(td.fx)}`);}
  // NaN-geometry sniffer rows - owner path + attr signature, so the next
  // "radius is NaN" console burst already names its source.
  if (td.geoNaN?.length) {lines.push(`geoNaN: ${td.geoNaN.map((h): string => `${h.uuid}@${h.at}s ${h.owner}${h.tag ? `<${h.tag}>` : ''}`).join(' | ')}`);}
  pushBallCensus(lines, td);
  pushShellAudit(lines, ctx);
  pushUnclaimed(lines, td);
}



// Ball trail census - emit gates (speed >0.7, cam <200m) vs outputs
// (live dots, ribbon samples). "spd=0 dots=0" everywhere = the shared
// starvation case; "dots>0 but no sparkle" = a render/batch break.
function pushBallCensus(lines: string[], td: TrailDump): void {
  if (td.ballDots) {lines.push(`ballDots: ${JSON.stringify(td.ballDots)}`);}
  if (td.balls) {
    lines.push(`balls: ${td.balls.rows?.length ?? 0} live viewPos=${td.balls.viewPos ?? '?'}`);
    for (const r of td.balls.rows ?? []) {
      const s = slim(r, BALL_ROW_DEF);
      // Nested rib/dots records get their own defaults - same idea as
      // the flat slim, one level down.
      if (Array.isArray(s.rib)) {s.rib = (s.rib as Record<string, unknown>[]).map((x): { [x: string]: unknown; } => slim(x, BALL_RIB_DEF));}
      if (s.dots && typeof s.dots === 'object') {s.dots = slim(s.dots as Record<string, unknown>, BALL_DOTS_DEF);}
      lines.push(`  ball ${JSON.stringify(s)}`);
    }
  }
}



// Projectile audit - the oldest-shell line surfaces the next immortal
// early; the offWorld count catches shells that escaped the sane-bounds
// box (a garbage trail census usually traces back to one of these).
function pushShellAudit(lines: string[], ctx: StateDebugContext): void {
  const aged = ctx.projectiles.toSorted((a, b): number => b.age - a.age).slice(0, 5);
  if (aged.length > 0) {
    lines.push(`oldest: ${aged.map((pr): string => `${pr.config.name}@${pr.age.toFixed(1)}s(${pr.pos.x.toFixed(0)},${pr.pos.y.toFixed(0)},${pr.pos.z.toFixed(0)})`).join(' ')}`);
  }
  let offWorld = 0;
  for (const pr of ctx.projectiles) {
    if (pr.pos.y < -500 || Math.abs(pr.pos.x) > 4000 || Math.abs(pr.pos.z) > 4000) {offWorld += 1;}
  }
  if (offWorld) {lines.push(`offWorld: ${offWorld} projectiles outside sane bounds`);}
}


function pushUnclaimed(lines: string[], td: TrailDump): void {
  for (const [k, v] of Object.entries(td)) {
    if (TRAIL_CLAIMED.has(k) || v == null) {continue;}
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (!s || s === '{}' || s === '[]') {continue;}
    lines.push(`${k}: ${s.length > 600 ? `${s.slice(0, 600)  }…` : s}`);
  }
}



// Generic pass-through - collectDiag merges EVERY registerDiag section,
// so keys this census has no bespoke format for must still reach the
// paste; before this sweep, glitches/visAudit/the net reject censuses
// and vfx.drivers were collected and silently dropped.
const TRAIL_CLAIMED = new Set([
  'stats', 'pools', 'trails', 'ribbons', 'ribbonBatch', 'ribbonOrphans',
  'litAudit', 'reapedLit', 'inst', 'swarm', 'fx', 'geoNaN', 'ballDots', 'balls',
]);
