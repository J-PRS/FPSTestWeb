import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import { Minimap } from './minimap.js';
import { createHudDom } from './hud/dom.js';
import { PlayerIndicators } from './hud/indicators.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import { Scoreboard, type SbRow } from './hud/scoreboard.js';
import { HudStats } from './hud/hudStats.js';

import { Player } from '../entities/Player.js';

const countSpan = (n: number) => `<span class="${n > 0 ? 'hot' : 'dim'}">${n}</span>`;

const paintFlagChip = (el: HTMLElement, st?: string) => {
  el.style.display = st ? '' : 'none';
  if (!st) return;
  el.textContent = st === 'home' ? '⚑' : st === 'carried' ? '⚑ TAKEN' : '⚑ LOOSE';
  el.classList.toggle('taken', st !== 'home');
};

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
  private playerList: HTMLDivElement;
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
    this.stats = new HudStats(this);
    this.minimap = new Minimap(this.el);
    this.indicators = new PlayerIndicators(this.el);
  }

  private killFeed: HTMLDivElement;

  /** Kill feed — "shooter [weapon] ▸ target" under the match strip. Timed
   *  fade, capped at 6 rows; textContent only (names are server strings). */
  feedKill(shooter: string, target: string, localIsShooter: boolean, localIsTarget: boolean, weapon?: number): void {
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (localIsShooter) row.classList.add('me');
    // Self-inflicted kill (own splash): "X cratered" — "X ▸ X" reads as a
    // normal frag in the feed.
    const suicide = shooter === target;
    const s = document.createElement('span');
    s.className = 'kf-s';
    s.textContent = shooter === 'environment' ? '☠' : shooter;
    const w = document.createElement('span');
    w.className = 'kf-w';
    // Enum-name reverse lookup: `WeaponType[7]` → 'PlasmaCannon'. Unknown/absent → nothing shown.
    w.textContent = weapon !== undefined && WeaponType[weapon] ? `[${WeaponType[weapon]}] ` : '';
    const t = document.createElement('span');
    t.className = 'kf-t' + (localIsTarget ? ' dead' : '');
    t.textContent = suicide ? 'self' : target;
    row.append(s, w, t);
    this.killFeed.append(row);
    while (this.killFeed.childElementCount > 6) this.killFeed.firstElementChild!.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600); }, 5200);
    const wname = weapon !== undefined && WeaponType[weapon] ? ` [${WeaponType[weapon]}]` : '';
    this.logEvent(suicide ? `${target}${wname} cratered` : `${shooter}${wname} ▸ ${target}`, localIsShooter ? 'me' : localIsTarget ? 'dead' : undefined);
  }

  /** Run clock — MM:SS, DOM write only when the second rolls over */
  setTimer(seconds: number): void {
    const s = Math.floor(seconds);
    if (s === this.lastTimerSec) return;
    this.lastTimerSec = s;
    this.timerEl.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
  setTeamScore(a: number, b: number): void {
    this.teamScore.style.display = 'block';
    this.tsA.textContent = String(a);
    this.tsB.textContent = String(b);
  }

  /** Match clock + flag chips under the score strip. null hides the
   *  strip's clock; flag chips show only for teams the wire described. */
  private matchStatus!: HTMLDivElement;
  private matchClock!: HTMLElement;
  private flagA!: HTMLElement;
  private flagB!: HTMLElement;
  private lastClockTxt = '';
  private lastFlagsKey = '';

  setMatchStatus(msLeft: number | null, flags: { alpha?: string; bravo?: string }): void {
    const hasAny = msLeft !== null || flags.alpha || flags.bravo;
    this.matchStatus.style.display = hasAny ? 'flex' : 'none';
    if (!hasAny) return;
    let txt = '';
    if (msLeft !== null) {
      const s = Math.max(0, Math.floor(msLeft / 1000));
      txt = msLeft <= 0 ? 'OT' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      this.matchClock.classList.toggle('late', msLeft < 60_000);
      this.matchClock.style.display = '';
    } else {
      this.matchClock.style.display = 'none';
    }
    if (txt !== this.lastClockTxt) { this.lastClockTxt = txt; this.matchClock.textContent = txt; }
    const key = `${flags.alpha ?? ''}|${flags.bravo ?? ''}`;
    if (key !== this.lastFlagsKey) {
      this.lastFlagsKey = key;
      paintFlagChip(this.flagA, flags.alpha);
      paintFlagChip(this.flagB, flags.bravo);
    }
  }

  /** Nuggets collected — DOM write only on change */
  setNuggets(n: number): void {
    this.stats.setText(this.ammo, 'nuggets', String(n));
  }

  setScoreboardVisible(v: boolean): void { this.sb.setVisible(v); }

  get scoreboardVisible(): boolean { return this.sb.isVisible; }

  setScoreboardRows(rows: SbRow[]): void { this.sb.setRows(rows); }

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
  private deathOverlay: HTMLDivElement | null = null;
  private deathClock: HTMLDivElement | null = null;
  private diedAt = 0;
  private lastDeathTxt = '';

  setDeathOverlay(on: boolean): void {
    if (on && !this.deathOverlay) {
      const d = document.createElement('div');
      d.id = 'death-overlay';
      const c = document.createElement('div');
      c.className = 'death-clock';
      d.appendChild(c);
      document.body.appendChild(d);
      this.deathOverlay = d;
      this.deathClock = c;
      this.diedAt = performance.now();
      this.lastDeathTxt = '';
    } else if (!on && this.deathOverlay) {
      this.deathOverlay.remove();
      this.deathOverlay = null;
      this.deathClock = null;
    }
  }

  /** Frame tick while dead — counts down to the server respawnMs deadline. */
  updateDeathCountdown(respawnMs: number): void {
    if (!this.deathClock) return;
    const left = Math.max(0, respawnMs - (performance.now() - this.diedAt));
    const txt = left > 0 ? `RESPAWN IN ${(left / 1000).toFixed(1)}` : 'RESPAWNING';
    if (txt !== this.lastDeathTxt) {
      this.deathClock.textContent = txt;
      this.lastDeathTxt = txt;
    }
  }

  // Spectator chrome: HUD hides entirely while flying; this hint is all
  // that remains so the exit key stays discoverable.
  private spectateHint: HTMLDivElement | null = null;

  setSpectatorHint(on: boolean): void {
    if (on && !this.spectateHint) {
      const d = document.createElement('div');
      d.id = 'spectate-hint';
      d.textContent = 'SPECTATING';
      document.body.appendChild(d);
      this.spectateHint = d;
    } else if (!on && this.spectateHint) {
      this.spectateHint.remove();
      this.spectateHint = null;
    }
  }

  /* Status effects (cloak/shield/mend) share one chrome shape: a top-center
     chip + a full-screen edge vignette. Colors/offsets live in hud.css —
     these methods just flip elements on and off. */
  private statusFx = new Map<string, { hint: HTMLDivElement; vig: HTMLDivElement }>();

  private setStatusFx(kind: 'cloak' | 'shield' | 'mend', label: string, on: boolean): void {
    const fx = this.statusFx.get(kind);
    if (on && !fx) {
      const vig = document.createElement('div');
      vig.className = `status-vignette ${kind}`;
      const hint = document.createElement('div');
      hint.className = `status-hint ${kind}`;
      hint.textContent = label;
      document.body.append(vig, hint);
      this.statusFx.set(kind, { hint, vig });
    } else if (!on && fx) {
      fx.hint.remove();
      fx.vig.remove();
      this.statusFx.delete(kind);
    }
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

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[], players?: Iterable<import('./minimap.js').MinimapPlayer>): void {
    this.minimap.update(targets, nuggets, pos, yaw, birds, players);
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.stats.tick(dt, player, ping, packetLoss, jitter);

    // Scoreboard: rebuild rows at 4Hz while open (live ping/frags)
    this.sb.tick(dt);
  }

  updatePlayerIndicator(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, isDead: boolean = false, friendly = false, sheep?: number): void {
    this.indicators.update(playerId, position, camera, { isDead, friendly, sheep });
  }

  /** CTF flag marker — same through-terrain DOM overlay as player dots,
   *  styled as a team-colored diamond so it can't be mistaken for a player. */
  updateFlagIndicator(id: string, position: { x: number; y: number; z: number },
                      camera: THREE.Camera, team: 'alpha' | 'bravo'): void {
    this.indicators.update(id, position, camera, { variant: `flag ${team}` });
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
