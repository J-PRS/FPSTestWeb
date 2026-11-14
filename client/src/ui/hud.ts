import * as THREE from 'three';
import { Minimap , type MinimapPlayer, type MinimapNode } from './minimap.js';
import { CommandMap, type SpawnPools } from './commandmap.js';
import { createHudDom } from './hud/dom.js';
import { tokenTier } from '../../../shared/pickups.js';
import { PlayerIndicators } from './hud/indicators.js';
import { ndcToClient } from './ndcScreen.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import { Scoreboard, type SbRow } from './hud/scoreboard.js';
import { HudStats } from './hud/hudStats.js';
import * as ch from './hud/hudChrome.js';

import type { Player } from '../entities/Player.js';
import type { TeamId } from '../../../shared/teams.js';
import { feedNames } from '../../../shared/botNames.js';

const countSpan = (n: number): string => `<span class="${n > 0 ? 'hot' : 'dim'}">${n}</span>`;

export class HUD {
  private el: HTMLDivElement;
  health: HTMLSpanElement  // public — HudStats family paints it;
  energy: HTMLSpanElement  // public — HudStats family paints it;
  private ammo: HTMLSpanElement;
  private beltFill!: HTMLElement;
  speed: HTMLSpanElement  // public — HudStats family paints it;
  speedH: HTMLSpanElement  // public — HudStats family paints it;
  speedV: HTMLSpanElement  // public — HudStats family paints it;
  kills: HTMLSpanElement  // public — HudStats family paints it;
  state: HTMLSpanElement  // public — HudStats family paints it;
  ping: HTMLSpanElement  // public — HudStats family paints it;
  loss: HTMLSpanElement  // public — HudStats family paints it;
  jitter: HTMLSpanElement  // public — HudStats family paints it;
  fps: HTMLSpanElement  // public — HudStats family paints it;
  crosshair: HTMLDivElement;
  hitMarker: HTMLDivElement  // public — HudStats family paints it;
  private minimap: Minimap;
  private cmdmap: CommandMap;
  dmgVignette: HTMLDivElement  // public — HudStats family paints it;
  dmgEdge: HTMLDivElement  // public — HudStats family paints it;
  dmgDir: HTMLDivElement  // public — HudStats family paints it;
  dmgDirArc: HTMLDivElement  // public — HudStats family paints it;
  ghostBar: HTMLDivElement  // public — HudStats family paints it;
  private indicators!: PlayerIndicators;
  // Per-frame stat painter (vitals, speed, telemetry, slots,
  // hit marker, damage fx, buffs, fps) — hud/hudStats.ts
  private stats!: HudStats;
  playerList: HTMLDivElement;
  private ballCountEl: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private lastBallCount = -1;
  private lastTimerSec = -1;
  private teamScore: HTMLDivElement;
  private tsA: HTMLElement;
  private tsB: HTMLElement;
  private heldCount: HTMLDivElement;
  private classicScore: HTMLDivElement;
  armor: HTMLSpanElement  // public — HudStats family paints it;
  armorBar: HTMLDivElement  // public — HudStats family paints it;
  buffsRow: HTMLDivElement  // public — HudStats family paints it;

  constructor() {
    const d = createHudDom();
    this.el = d.el;
    this.health = d.health;
    this.energy = d.energy;
    this.ammo = d.ammo;
    this.beltFill = d.beltFill;
    this.speed = d.speed;
    this.speedH = d.speedH;
    this.speedV = d.speedV;
    this.kills = d.kills;
    this.state = d.state;
    this.ping = d.ping;
    this.loss = d.loss;
    this.jitter = d.jitter;
    this.fps = d.fps;
    this.crosshair = d.crosshair;
    this.hitMarker = d.hitMarker;
    this.dmgVignette = d.dmgVignette;
    this.dmgEdge = d.dmgEdge;
    this.dmgDir = d.dmgDir;
    this.dmgDirArc = d.dmgDirArc;
    this.ghostBar = d.ghostBar;
    this.playerList = d.playerList;
    this.ballCountEl = d.ballCountEl;
    this.timerEl = d.timerEl;
    this.weaponBar = d.weaponBar;
    this.weaponSlots = d.weaponSlots;
    this.healthBar = d.healthBar;
    this.energyBar = d.energyBar;
    this.armor = d.armor;
    this.armorBar = d.armorBar;
    this.buffsRow = d.buffsRow;
    this.sb = new Scoreboard(d.scoreboard, d.sbRows);
    this.teamScore = d.teamScore;
    this.tsA = d.tsA;
    this.tsB = d.tsB;
    this.heldCount = d.heldCount;
    this.classicScore = d.classicScore;
    this.matchStatus = d.matchStatus;
    this.matchClock = d.matchClock;
    this.flagA = d.flagA;
    this.flagB = d.flagB;
    this.killFeed = d.killFeed;
    this.connBanner = d.connBanner;
    this.sheepReadout = d.sheepReadout;
    this.energyReadout = d.energyReadout;
    this.groundReadout = d.groundReadout;
    this.wammoReadout = d.wammoReadout;
    this.wammoRegenFill = d.wammoRegenFill;
    this.bloomRing = d.bloomRing;
    this.stats = new HudStats(this);
    this.minimap = new Minimap(this.el);
    this.cmdmap = new CommandMap(this.el);
    this.indicators = new PlayerIndicators(this.el);
  }

  killFeed: HTMLDivElement;
  connBanner: HTMLDivElement;
  sheepReadout: HTMLDivElement;
  energyReadout: HTMLDivElement;
  groundReadout: HTMLDivElement;
  wammoReadout: HTMLDivElement  // public - HudStats family paints it;
  wammoRegenFill: HTMLDivElement // public - regen sliver fill, painted per-frame;
  bloomRing: HTMLDivElement     // public - bloom cone affordance, painted per-frame;

  private lastSheepShown = -1;
  private lastEnergyShown = -1;
  /** Own sheep score under the crosshair — same thresholds/colors as the
   *  bot indicator badges so the number reads identically everywhere. */
  setSheep(shown: number): void {
    if (shown === this.lastSheepShown) {return;}
    this.lastSheepShown = shown;
    if (shown <= 0) { this.sheepReadout.textContent = ''; return; }
    this.sheepReadout.textContent = `${shown}`;
    let sheepColor = '#7ddf7d';
    if (shown >= 60) {sheepColor = '#ff6b6b';}
    else if (shown >= 30) {sheepColor = '#ffd166';}
    this.sheepReadout.style.color = sheepColor;
  }

  /** Total mechanical energy (KE+PE) as equivalent flat-ground speed —
   *  ½v² + g·h reads in m²/s², but "42 E" where E is sqrt(2·E) keeps the
   *  number in the same m/s head-units as the speedo. Suffix shows the
   *  split so height↔speed conversion is visible mid-ski. */
  setEnergy(parts: { ke: number; pe: number; mech: number } | undefined): void {
    const shown = parts ? Math.round(Math.sqrt(2 * parts.mech)) : 0;
    if (shown === this.lastEnergyShown) {return;}
    this.lastEnergyShown = shown;
    if (!parts || shown <= 0) { this.energyReadout.textContent = ''; return; }
    const k = Math.round(Math.sqrt(2 * parts.ke));
    const p = Math.round(Math.sqrt(2 * parts.pe));
    this.energyReadout.textContent = `E ${shown} (${k}k ${p}p)`;
  }

  /** Air/ground probe under the energy readout — tag plus height above
   *  the terrain surface so the grounded flag's actual behavior is visible. */
  setGround(grounded: boolean, terrainDist: number): void {
    const text = `[${grounded ? 'G' : 'A'}] ${Math.max(0, terrainDist).toFixed(1)}m`;
    if (text === this.groundReadout.textContent) {return;}
    this.groundReadout.textContent = text;
  }

  /** Kill feed — "shooter [weapon] ▸ target" under the match strip. Timed
   *  fade, capped at 6 rows; textContent only (names are server strings). */
  feedKill(shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean,
    meta?: { shooter?: string; target?: string; weapon?: number; air?: number; sName?: string; tName?: string }): void {
    ch.feedKill(this, shooter, target, localIsShooter, localIsTarget, meta);
  }

  /** Run clock is only meaningful while the wave director ticks (offline
   *  sandbox) — online/matches it's a frozen 00:00, so hide it. */
  setTimerVisible(v: boolean): void {
    this.timerEl.style.display = v ? '' : 'none';
  }

  /** Run clock — MM:SS, DOM write only when the second rolls over */
  setTimer(seconds: number): void {
    const s = Math.floor(seconds);
    if (s === this.lastTimerSec) {return;}
    this.lastTimerSec = s;
    this.timerEl.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Entity census row is a debug panel — shown by the ` toggle that
   *  drives stats.js + perfHud, hidden in normal play. */
  setEntCountsVisible(v: boolean): void {
    this.ballCountEl.style.display = v ? 'block' : 'none';
  }

  /** Live ball count — DOM write only on change */
  setBallCount(n: number): void {
    if (n === this.lastBallCount) {return;}
    this.lastBallCount = n;
    this.ballCountEl.textContent = String(n);
  }

  /** Detailed entity/effect census — bottom-left, DOM write only on change.
   *  Three lines: fodder, hunters (chase/attack you), and load counters
   *  that matter for perf (total targets, projectiles, active FX). */
  setEntityCounts(c: {
    balls: number; elites: number; crawlers: number; scarabs: number;
    grubs: number; snakes: number; gnats: number; seekers: number;
    rakks: number; rollers: number; turrets: number; overlords: number;
    totems: number; mines: number; targets: number;
    projectiles: number; fx: number;
  }): void {
    const fodder = c.scarabs + c.grubs + c.gnats;
    const hunters = c.crawlers + c.seekers + c.rakks + c.rollers + c.snakes;
    const siegers = c.turrets + c.overlords + c.totems;
    const key = `${c.balls}|${c.elites}|${c.crawlers}|${c.scarabs}|${c.grubs}|${c.snakes}|${c.gnats}|${c.seekers}|${c.rakks}|${c.rollers}|${c.turrets}|${c.overlords}|${c.totems}|${c.mines}|${c.targets}|${c.projectiles}|${c.fx}`;
    if (key === this.lastCountsKey) {return;}
    this.lastCountsKey = key;
    this.ballCountEl.innerHTML =
      `<span class="dim">balls</span> ${countSpan(c.balls)}${c.elites ? ` <span class="dim">+elite</span> ${countSpan(c.elites)}` : ''}` +
      ` <span class="dim">tgt</span> ${countSpan(c.targets)} <span class="dim">fodder</span> ${countSpan(fodder)} <span class="dim">(scr ${c.scarabs} grb ${c.grubs} gnt ${c.gnats})</span>\n` +
      `<span class="dim">hunt</span> ${countSpan(hunters)} <span class="dim">(crw ${c.crawlers} snk ${c.snakes} sek ${c.seekers} rak ${c.rakks} bld ${c.rollers})</span>\n` +
      `<span class="dim">siege</span> ${countSpan(siegers)} <span class="dim">(tur ${c.turrets} ovl ${c.overlords} tot ${c.totems}) mine ${c.mines} · proj ${c.projectiles} fx ${c.fx}</span>`;
  }
  private lastCountsKey = '';

  /** Nugget Wars team totals — shown only while the mode runs. */
  private lastTeamScore = '';
  setTeamScore(a: number, b: number): void {
    const key = `${a}|${b}`;
    if (key === this.lastTeamScore) {return;}
    this.lastTeamScore = key;
    this.teamScore.style.display = 'block';
    this.tsA.textContent = String(a);
    this.tsB.textContent = String(b);
  }
  /** Solo matches set the strip once and never clear it - call on
   *  transitions where the mode stops owning the scoreboard. */
  hideTeamScore(): void {
    if (this.lastTeamScore !== 'off') {this.lastTeamScore = 'off'; this.teamScore.style.display = 'none';}
  }

  /** ?mode=classic top-center readout — the Unity layout: "score - kills"
   *  over a running-seconds clock. null hides it (non-classic modes). */
  private lastClassicKey = '';
  setClassicScore(parts: { score: number; kills: number; seconds: number } | null): void {
    if (!parts) {
      if (this.lastClassicKey !== 'off') { this.lastClassicKey = 'off'; this.classicScore.style.display = 'none'; }
      return;
    }
    // Headhunt/team modes own this strip too - when teamScore is live it
    // wins, or the "0 - 0" line overlaps the ALPHA/BRAVO readout.
    if (this.lastTeamScore !== 'off' && this.lastTeamScore !== '') {this.classicScore.style.display = 'none'; return;}
    this.classicScore.style.display = 'block';
    // Two children, written independently — the clock rolls at frame rate.
    const line = `${parts.score} - ${parts.kills}`;
    const kids = this.classicScore.children;
    if (kids[0]!.textContent !== line) {kids[0]!.textContent = line;}
    const time = parts.seconds.toFixed(2);
    if (kids[1]!.textContent !== time) {kids[1]!.textContent = time;}
  }

  /** Match clock + flag chips under the score strip. null hides the
   *  strip's clock; flag chips show only for teams the wire described. */
  matchStatus!: HTMLDivElement;
  matchClock!: HTMLElement;
  flagA!: HTMLElement;
  flagB!: HTMLElement;
  lastClockTxt = '';
  lastFlagsKey = '';

  setMatchStatus(msLeft: number | null, flags: { alpha?: string; bravo?: string }): void {
    ch.setMatchStatus(this, msLeft, flags);
  }

  /** Nuggets collected + regen sliver — DOM writes only on change */
  setNuggets(n: number, regenFrac = 0): void {
    this.stats.setText(this.ammo, 'nuggets', String(n));
    this.stats.setStyle(this.beltFill, 'beltfill', 'transform', `scaleX(${regenFrac.toFixed(3)})`);
  }

  /** Headhunt held tokens — the prominent counter above the stat block.
   *  Font grows with the pile: your number inflating IS the warning
   *  that you're becoming the lobby's target. null or 0 hides it. */
  private lastHeldKey = '';
  setHeld(n: number | null): void {
    if (n === null || n <= 0) {
      if (this.lastHeldKey !== 'off') { this.lastHeldKey = 'off'; this.heldCount.style.display = 'none'; }
      return;
    }
    const size = Math.min(30, 18 + Math.floor(n * 0.6));
    const key = `${n}|${size}`;
    if (key === this.lastHeldKey) {return;}
    this.lastHeldKey = key;
    this.heldCount.style.display = 'block';
    const num = this.heldCount.querySelector('#held-n') as HTMLElement;
    num.textContent = String(n);
    num.style.fontSize = `${size}px`;
    // Top denomination colors your pile — a purple number means you're
    // carrying a purple-or-better hoard.
    this.heldCount.style.color = `#${tokenTier(n).color.toString(16).padStart(6, '0')}`;
  }

  setScoreboardVisible(v: boolean): void { this.sb.setVisible(v); }

  get scoreboardVisible(): boolean { return this.sb.isVisible; }

  setScoreboardRows(rows: SbRow[]): void { this.sb.setRows(rows); }
  setScoreboardPingVisible(v: boolean): void { this.sb.setPingVisible(v); }
  setScoreboardNetVisible(v: boolean): void { this.sb.setNetVisible(v); }
  setScoreboardTeamScores(s: { alpha: number; bravo: number } | null): void { this.sb.setTeamScores(s); }

  /** Intermission footer on the board — "NEXT MATCH IN N". */
  setScoreboardCountdown(secLeft: number | null): void { this.sb.setCountdown(secLeft); }

  /** Header over the roster — "CAPTURE THE FLAG · Dangerous Crossing". */
  setScoreboardTitle(t: string): void { this.sb.setTitle(t); }

  weaponBar!: HTMLDivElement;
  weaponSlots: HTMLSpanElement[] = [];  // public — HudStats family paints it
  healthBar!: HTMLDivElement;
  energyBar!: HTMLDivElement;
  private sb!: Scoreboard;

  showHitMarker(): void { this.stats.hit(); }

  hide(): void {
    this.el.style.display = 'none';
  }

  show(): void {
    this.el.style.display = 'block';
  }

  // Death overlay: desaturate the world + dark vignette while dead.
  // Lives outside #hud (appended to body) so hide() doesn't remove it;
  // pure DOM/CSS — one backdrop-filter composite, no render-pass cost.
  deathOverlay: HTMLDivElement | null = null;
  deathClock: HTMLDivElement | null = null;
  diedAt = 0;
  lastDeathTxt = '';

  setDeathOverlay(on: boolean): void { ch.setDeathOverlay(this, on); }
  updateDeathCountdown(respawnMs: number, held = false): void { ch.updateDeathCountdown(this, respawnMs, held); }
  // Spectator chrome: HUD hides entirely while flying; this hint is all
  // that remains so the exit key stays discoverable.
  spectateHint: HTMLDivElement | null = null;
  setSpectatorHint(on: boolean): void { ch.setSpectatorHint(this, on); }

  /* Status effects (cloak/shield/mend) share one chrome shape: a top-center
     chip + a full-screen edge vignette. */
  statusFx = new Map<string, { hint: HTMLDivElement; vig: HTMLDivElement }>();
  private setStatusFx(kind: 'cloak' | 'shield' | 'mend', label: string, on: boolean): void {
    ch.setStatusFx(this, kind, label, on);
  }

  // Cloak reads as indigo, shield as cyan, mend as green — the energy bar
  // shows the drain/soak underneath.
  setCloak(on: boolean): void { this.setStatusFx('cloak', 'CLOAKED', on); }
  setShield(on: boolean): void { this.setStatusFx('shield', 'SHIELDED', on); }
  setMend(on: boolean): void { this.setStatusFx('mend', 'MENDING', on); }
  /** Local player took damage — vignette pulse scaled to the hit, plus a
   *  directional arc pointing at the source when we know where it is. */
  showDamage(fromPos: THREE.Vector3 | null, damage: number): void {
    this.stats.damage(fromPos, damage);
  }

  /** Shielded hit — same directional language but cyan: the bubble ate it. */
  showShieldDamage(fromPos: THREE.Vector3 | null, damage: number): void {
    this.stats.shieldDamage(fromPos, damage);
  }

  /* Connection-loss banner: while an online session's socket is down it
     counts up live; on reconnect it flashes 'was down X.Xs' for a few
     seconds so even sub-second drops stay visible (dev readout). */
  private connDownAt = 0;
  private connFlashUntil = 0;
  private connFlashTxt = '';
  private connFlashCls: 'up' | 'warn' = 'up';
  private connLastTxt = '';
  /** Server-flagged warning (anti-cheat verdict) — reuses the conn-banner
   *  slot in amber for a few seconds; setConnDown's per-frame pass renders
   *  it via the flash path. */
  serverWarn(text: string): void {
    this.connFlashUntil = performance.now() + 6000;
    this.connFlashTxt = text;
    this.connFlashCls = 'warn';
  }
  /** Live complaint feed — Logger WARN+ lines (ghost shells, dead lanes,
   *  GLITCH parity misses) surface in the conn-banner for a beat instead
   *  of only sitting in the console/log buffer. The down-state paint
   *  wins while the socket is actually out, so a complaint can't mask a
   *  real disconnect; the latest complaint wins the slot until it expires. */
  complaint(line: string): void {
    if (this.connDownAt) {return;}
    // logLine is `${ts} [tag] [LEVEL] msg` — drop the timestamp, cap the
    // banner at one readable line.
    const txt = line.replace(/^\S+ /, '').slice(0, 110);
    this.connFlashUntil = performance.now() + 4000;
    this.connFlashTxt = txt;
    this.connFlashCls = 'warn';
  }
  setConnDown(down: boolean, reason?: string | null): void {
    const now = performance.now();
    if (down) {
      if (!this.connDownAt) {this.connDownAt = now;}
      const s = (now - this.connDownAt) / 1000;
      // A reasoned close ('server restarting') names itself and reads
      // amber — expected, transient. A silent 1006 keeps the generic red
      // CONNECTION LOST — that's the one that means something broke.
      const label = reason ? reason.toUpperCase() : 'CONNECTION LOST';
      this.paintConn(`${label} — reconnecting ${s.toFixed(1)}s`, reason ? 'warn' : 'down');
      return;
    }
    if (this.connDownAt) {
      const s = (now - this.connDownAt) / 1000;
      this.connDownAt = 0;
      this.connFlashUntil = now + 4000;
      this.connFlashTxt = `back online — was down ${s.toFixed(1)}s`;
    }
    if (now < this.connFlashUntil) {
      this.paintConn(this.connFlashTxt, this.connFlashCls);
    } else {
      this.connFlashCls = 'up';
      this.connBanner.style.display = 'none';
      this.connLastTxt = '';
    }
  }
  private paintConn(txt: string, cls: 'down' | 'up' | 'warn'): void {
    if (this.connBanner.className !== cls) {this.connBanner.className = cls;}
    if (txt === this.connLastTxt) {return;}
    this.connLastTxt = txt;
    this.connBanner.textContent = txt;
    this.connBanner.style.display = 'block';
  }

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[], players?: Iterable<MinimapPlayer>, nodes?: Iterable<MinimapNode>): void {
    this.minimap.update(targets, nuggets, pos, yaw, birds, players, nodes);
  }

  toggleCommandMap(force?: boolean): void { this.cmdmap.toggle(force); }
  get commandMapOpen(): boolean { return this.cmdmap.isOpen; }

  updateCommandMap(pos: THREE.Vector3, yaw: number, players: Iterable<MinimapPlayer>,
                   flags: Map<TeamId, { home: THREE.Vector3; homeKnown: boolean; carrier: string | null; wirePos: THREE.Vector3 }>,
                   nodes?: Map<number, { pos: THREE.Vector3; owner: 'alpha' | 'bravo' | 'neutral'; core: boolean }>,
                   spawnPools?: SpawnPools | null): void {
    this.cmdmap.update(pos, yaw, players, flags, nodes, spawnPools);
  }

  /** A frame was presented — feeds the FPS readout. Called only on
   *  render frames; the loop ticks faster than renders under fps-cap. */
  markFrame(elapsed: number): void { this.stats.rendered(elapsed); }

  update(dt: number, player: Player, ping = 0, packetLoss = 0, jitter = 0): void {
    this.stats.tick(dt, player, ping, packetLoss, jitter);

    // Scoreboard: rebuild rows at 4Hz while open (live ping/frags)
    this.sb.tick(dt);
  }

  updatePlayerIndicator(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, opts: { isDead?: boolean; friendly?: boolean; mem?: boolean; sheep?: number; bot?: boolean; cls?: string; hp?: number; held?: number; name?: string } = {}): void {
    this.indicators.update(playerId, position, camera, opts);
  }

  /** CTF flag marker — same through-terrain DOM overlay as player dots,
   *  styled as a team-colored diamond so it can't be mistaken for a player.
   *  `kind:'stand'` draws the hollow socket the flag diamond nests in —
   *  paired at home they read as one complete mark. */
  updateFlagIndicator(id: string, position: { x: number; y: number; z: number },
                      camera: THREE.Camera, team: TeamId | 'rabbit' | 'neutral', kind: 'flag' | 'stand' = 'flag'): void {
    this.indicators.update(id, position, camera, { variant: `${kind} ${team}` });
  }

  /** Targeting-beacon aim reticles — Deployables solves both lob roots
   *  each frame (low/direct + high arc) and hands the world-space aim
   *  points here; null hides that marker. `reachable=false` means the
   *  current gun's arc can't carry that far (single shared marker). */
  private readonly beaconEls = new Map<string, HTMLDivElement>();
  private readonly _beaconProj = new THREE.Vector3();
  updateBeaconAim(low: THREE.Vector3 | null, lob: THREE.Vector3 | null, camera: THREE.Camera, reachable: boolean): void {
    this.paintBeaconEl('low', low, camera, reachable);
    this.paintBeaconEl('lob', lob, camera, reachable);
  }
  private paintBeaconEl(key: string, point: THREE.Vector3 | null, camera: THREE.Camera, reachable: boolean): void {
    let el = this.beaconEls.get(key);
    if (!point) { el?.classList.add('hidden'); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = `beacon-aim ${key}`;
      this.el.append(el);
      this.beaconEls.set(key, el);
    }
    el.classList.toggle('noarc', !reachable);
    const v = this._beaconProj.copy(point).project(camera);
    if (v.z > 1) { // behind the camera — no honest on-screen position
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const scr = { x: 0, y: 0 };
    ndcToClient(v.x, v.y, scr);
    let {x} = scr;
    let {y} = scr;
    // Long lobs aim nearly overhead — the aim point leaves the frustum but
    // the reticle must survive, so off-screen positions clamp to the edge
    // pointing at the arc (same read as off-screen player indicators).
    const m = 14;
    const onScreen = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
    if (onScreen) {
      el.classList.remove('edge');
    } else {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const ang = Math.atan2(y - cy, x - cx);
      const hw = cx - m, hh = cy - m;
      const r = Math.min(hw / Math.abs(Math.cos(ang)), hh / Math.abs(Math.sin(ang)));
      x = cx + Math.cos(ang) * r;
      y = cy + Math.sin(ang) * r;
      el.classList.add('edge');
    }
    el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  removePlayerIndicator(playerId: string): void {
    this.indicators.remove(playerId);
  }

  clearPlayerIndicators(): void {
    this.indicators.clear();
  }

  /** Battle log — the old roster slot now scrolls match events (kills,
   *  deaths, flag grabs/caps/returns). Rows linger longer than the top-
   *  right feed so the timeline reads like a log, not a ticker. */
  logEvent(text: string, cls?: string): void {
    const row = document.createElement('div');
    row.className = `log-row${  cls ? ` ${cls}` : ''}`;
    row.textContent = feedNames(text);
    this.playerList.append(row);
    while (this.playerList.childElementCount > 9) {this.playerList.firstElementChild!.remove();}
    setTimeout((): void => row.remove(), 9000); // hard cut — see feedKill
  }
}
