import * as THREE from 'three';
import { Minimap } from './minimap.js';
import { createHudDom } from './hud/dom.js';
import { PlayerIndicators } from './hud/indicators.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import { Scoreboard, type SbRow } from './hud/scoreboard.js';
import { HudStats } from './hud/hudStats.js';
import * as ch from './hud/hudChrome.js';

import { Player } from '../entities/Player.js';
import type { TeamId } from '../../../shared/teams.js';

const countSpan = (n: number) => `<span class="${n > 0 ? 'hot' : 'dim'}">${n}</span>`;

export class HUD {
  private el: HTMLDivElement;
  health: HTMLSpanElement  // public — HudStats family paints it;
  energy: HTMLSpanElement  // public — HudStats family paints it;
  private ammo: HTMLSpanElement;
  speed: HTMLSpanElement  // public — HudStats family paints it;
  speedH: HTMLSpanElement  // public — HudStats family paints it;
  speedV: HTMLSpanElement  // public — HudStats family paints it;
  kills: HTMLSpanElement  // public — HudStats family paints it;
  state: HTMLSpanElement  // public — HudStats family paints it;
  ping: HTMLSpanElement  // public — HudStats family paints it;
  loss: HTMLSpanElement  // public — HudStats family paints it;
  jitter: HTMLSpanElement  // public — HudStats family paints it;
  fps: HTMLSpanElement  // public — HudStats family paints it;
  private crosshair: HTMLDivElement;
  hitMarker: HTMLDivElement  // public — HudStats family paints it;
  private minimap: Minimap;
  dmgVignette: HTMLDivElement  // public — HudStats family paints it;
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
  armor: HTMLSpanElement  // public — HudStats family paints it;
  armorBar: HTMLDivElement  // public — HudStats family paints it;
  buffsRow: HTMLDivElement  // public — HudStats family paints it;

  constructor() {
    const d = createHudDom();
    this.el = d.el;
    this.health = d.health;
    this.energy = d.energy;
    this.ammo = d.ammo;
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
    this.dmgDir = d.dmgDir;
    this.dmgDirArc = d.dmgDirArc;
    this.ghostBar = d.ghostBar;
    this.playerList = d.playerList;
    this.ballCountEl = d.ballCountEl;
    this.timerEl = d.timerEl;
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
    this.matchStatus = d.matchStatus;
    this.matchClock = d.matchClock;
    this.flagA = d.flagA;
    this.flagB = d.flagB;
    this.killFeed = d.killFeed;
    this.connBanner = d.connBanner;
    this.sheepReadout = d.sheepReadout;
    this.energyReadout = d.energyReadout;
    this.stats = new HudStats(this);
    this.minimap = new Minimap(this.el);
    this.indicators = new PlayerIndicators(this.el);
  }

  killFeed: HTMLDivElement;
  connBanner: HTMLDivElement;
  sheepReadout: HTMLDivElement;
  energyReadout: HTMLDivElement;

  private lastSheepShown = -1;
  private lastEnergyShown = -1;
  /** Own sheep score under the crosshair — same thresholds/colors as the
   *  bot indicator badges so the number reads identically everywhere. */
  setSheep(shown: number): void {
    if (shown === this.lastSheepShown) return;
    this.lastSheepShown = shown;
    if (shown <= 0) { this.sheepReadout.textContent = ''; return; }
    this.sheepReadout.textContent = `${shown}`;
    this.sheepReadout.style.color = shown >= 60 ? '#ff6b6b' : shown >= 30 ? '#ffd166' : '#7ddf7d';
  }

  /** Total mechanical energy (KE+PE) as equivalent flat-ground speed —
   *  ½v² + g·h reads in m²/s², but "42 E" where E is sqrt(2·E) keeps the
   *  number in the same m/s head-units as the speedo. Suffix shows the
   *  split so height↔speed conversion is visible mid-ski. */
  setEnergy(parts: { ke: number; pe: number; mech: number } | undefined): void {
    const shown = parts ? Math.round(Math.sqrt(2 * parts.mech)) : 0;
    if (shown === this.lastEnergyShown) return;
    this.lastEnergyShown = shown;
    if (!parts || shown <= 0) { this.energyReadout.textContent = ''; return; }
    const k = Math.round(Math.sqrt(2 * parts.ke));
    const p = Math.round(Math.sqrt(2 * parts.pe));
    this.energyReadout.textContent = `E ${shown} (${k}k ${p}p)`;
  }

  /** Kill feed — "shooter [weapon] ▸ target" under the match strip. Timed
   *  fade, capped at 6 rows; textContent only (names are server strings). */
  feedKill(shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean, weapon?: number): void {
    ch.feedKill(this, shooter, target, localIsShooter, localIsTarget, weapon);
  }

  /** Run clock — MM:SS, DOM write only when the second rolls over */
  setTimer(seconds: number): void {
    const s = Math.floor(seconds);
    if (s === this.lastTimerSec) return;
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
    if (n === this.lastBallCount) return;
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
    if (key === this.lastCountsKey) return;
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
    if (key === this.lastTeamScore) return;
    this.lastTeamScore = key;
    this.teamScore.style.display = 'block';
    this.tsA.textContent = String(a);
    this.tsB.textContent = String(b);
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

  /** Nuggets collected — DOM write only on change */
  setNuggets(n: number): void {
    this.stats.setText(this.ammo, 'nuggets', String(n));
  }

  setScoreboardVisible(v: boolean): void { this.sb.setVisible(v); }

  get scoreboardVisible(): boolean { return this.sb.isVisible; }

  setScoreboardRows(rows: SbRow[]): void { this.sb.setRows(rows); }

  /** Header over the roster — "CAPTURE THE FLAG · Dangerous Crossing". */
  setScoreboardTitle(t: string): void { this.sb.setTitle(t); }

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
  updateDeathCountdown(respawnMs: number): void { ch.updateDeathCountdown(this, respawnMs); }
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
  setConnDown(down: boolean): void {
    const now = performance.now();
    if (down) {
      if (!this.connDownAt) this.connDownAt = now;
      const s = (now - this.connDownAt) / 1000;
      this.paintConn(`CONNECTION LOST — reconnecting ${s.toFixed(1)}s`, 'down');
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
    if (this.connBanner.className !== cls) this.connBanner.className = cls;
    if (txt === this.connLastTxt) return;
    this.connLastTxt = txt;
    this.connBanner.textContent = txt;
    this.connBanner.style.display = 'block';
  }

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[], players?: Iterable<import('./minimap.js').MinimapPlayer>): void {
    this.minimap.update(targets, nuggets, pos, yaw, birds, players);
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.stats.tick(dt, player, ping, packetLoss, jitter);

    // Scoreboard: rebuild rows at 4Hz while open (live ping/frags)
    this.sb.tick(dt);
  }

  updatePlayerIndicator(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, opts: { isDead?: boolean; friendly?: boolean; sheep?: number; bot?: boolean; cls?: string } = {}): void {
    this.indicators.update(playerId, position, camera, opts);
  }

  /** CTF flag marker — same through-terrain DOM overlay as player dots,
   *  styled as a team-colored diamond so it can't be mistaken for a player. */
  updateFlagIndicator(id: string, position: { x: number; y: number; z: number },
                      camera: THREE.Camera, team: TeamId): void {
    this.indicators.update(id, position, camera, { variant: `flag ${team}` });
  }

  /** Targeting-beacon aim reticle — Deployables solves the lob each frame
   *  and hands the world-space aim point here; null hides the marker.
   *  `reachable=false` means the current gun's arc can't carry that far. */
  private beaconAimEl: HTMLDivElement | null = null;
  private readonly _beaconProj = new THREE.Vector3();
  updateBeaconAim(point: THREE.Vector3 | null, camera: THREE.Camera, reachable: boolean): void {
    if (!point) {
      this.beaconAimEl?.classList.add('hidden');
      return;
    }
    if (!this.beaconAimEl) {
      this.beaconAimEl = document.createElement('div');
      this.beaconAimEl.className = 'beacon-aim';
      this.el.appendChild(this.beaconAimEl);
    }
    this.beaconAimEl.classList.toggle('noarc', !reachable);
    const v = this._beaconProj.copy(point).project(camera);
    if (v.z > 1) { // behind the camera — no honest on-screen position
      this.beaconAimEl.classList.add('hidden');
      return;
    }
    this.beaconAimEl.classList.remove('hidden');
    let x = (v.x * 0.5 + 0.5) * window.innerWidth;
    let y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    // Long lobs aim nearly overhead — the aim point leaves the frustum but
    // the reticle must survive, so off-screen positions clamp to the edge
    // pointing at the arc (same read as off-screen player indicators).
    const m = 14;
    const onScreen = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
    if (!onScreen) {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const ang = Math.atan2(y - cy, x - cx);
      const hw = cx - m, hh = cy - m;
      const r = Math.min(hw / Math.abs(Math.cos(ang)), hh / Math.abs(Math.sin(ang)));
      x = cx + Math.cos(ang) * r;
      y = cy + Math.sin(ang) * r;
      this.beaconAimEl.classList.add('edge');
    } else {
      this.beaconAimEl.classList.remove('edge');
    }
    this.beaconAimEl.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
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
    row.className = 'log-row' + (cls ? ` ${cls}` : '');
    row.textContent = text;
    this.playerList.appendChild(row);
    while (this.playerList.childElementCount > 9) this.playerList.firstElementChild!.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600); }, 9000);
  }
}
