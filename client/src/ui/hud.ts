import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import { Minimap } from './minimap.js';
import { createHudDom } from './hud/dom.js';
import { PlayerIndicators } from './hud/indicators.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';

import { Player } from '../entities/Player.js';

type SbRow = { name: string; frags: number; score: number | null; ping: number | null; net?: string | null; self: boolean; dead: boolean; team?: 'alpha' | 'bravo'; sheep?: number | null };

const countSpan = (n: number) => `<span class="${n > 0 ? 'hot' : 'dim'}">${n}</span>`;

const paintFlagChip = (el: HTMLElement, st?: string) => {
  el.style.display = st ? '' : 'none';
  if (!st) return;
  el.textContent = st === 'home' ? '⚑' : st === 'carried' ? '⚑ TAKEN' : '⚑ LOOSE';
  el.classList.toggle('taken', st !== 'home');
};

// textContent, not innerHTML — display names will be player-chosen
// strings; interpolating them raw is a stored-XSS hole in waiting.
function sbRowEl(r: SbRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = `${r.self ? 'self' : ''}${r.dead ? ' dead' : ''}${r.team ? ` sb-${r.team}` : ''}`;
  for (const cell of [r.name, String(r.frags), r.score === null ? '—' : String(r.score), r.net ?? '—', r.ping === null ? '—' : String(Math.round(r.ping)), r.sheep == null ? '—' : `${Math.round(r.sheep)}%`]) {
    const td = document.createElement('td');
    td.textContent = cell;
    tr.appendChild(td);
  }
  return tr;
}


export class HUD {
  private el: HTMLDivElement;
  private health: HTMLSpanElement;
  private energy: HTMLSpanElement;
  private ammo: HTMLSpanElement;
  private speed: HTMLSpanElement;
  private speedH: HTMLSpanElement;
  private speedV: HTMLSpanElement;
  private kills: HTMLSpanElement;
  private state: HTMLSpanElement;
  private ping: HTMLSpanElement;
  private loss: HTMLSpanElement;
  private jitter: HTMLSpanElement;
  private fps: HTMLSpanElement;
  private crosshair: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private minimap: Minimap;
  private hitTimer = 0;
  private dmgVignette: HTMLDivElement;
  private dmgDir: HTMLDivElement;
  private dmgDirArc: HTMLDivElement;
  private dmgT = 0;            // vignette decay
  private dmgDirT = 0;         // arc fade
  private lastPlayerPos = new THREE.Vector3();
  private lastPlayerYaw = 0;
  private ghostBar: HTMLDivElement;
  private ghostPct = 100;      // trails healthPct downward on damage
  private indicators!: PlayerIndicators;
  private playerList: HTMLDivElement;
  private ballCountEl: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private lastBallCount = -1;
  private lastTimerSec = -1;
  private teamScore: HTMLDivElement;
  private tsA: HTMLElement;
  private tsB: HTMLElement;
  private armor: HTMLSpanElement;
  private armorBar: HTMLDivElement;
  private buffsRow: HTMLDivElement;
  private lastArmor = -1;
  private lastBuffsKey = '';

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
    this.scoreboard = d.scoreboard;
    this.sbRows = d.sbRows;
    this.teamScore = d.teamScore;
    this.tsA = d.tsA;
    this.tsB = d.tsB;
    this.matchStatus = d.matchStatus;
    this.matchClock = d.matchClock;
    this.flagA = d.flagA;
    this.flagB = d.flagB;
    this.killFeed = d.killFeed;
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
    const s = document.createElement('span');
    s.className = 'kf-s';
    s.textContent = shooter === 'environment' ? '☠' : shooter;
    const w = document.createElement('span');
    w.className = 'kf-w';
    // Enum-name reverse lookup: `WeaponType[7]` → 'PlasmaCannon'. Unknown/absent → nothing shown.
    w.textContent = weapon !== undefined && WeaponType[weapon] ? `[${WeaponType[weapon]}] ` : '';
    const t = document.createElement('span');
    t.className = 'kf-t' + (localIsTarget ? ' dead' : '');
    t.textContent = target;
    row.append(s, w, t);
    this.killFeed.append(row);
    while (this.killFeed.childElementCount > 6) this.killFeed.firstElementChild!.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600); }, 5200);
    const wname = weapon !== undefined && WeaponType[weapon] ? ` [${WeaponType[weapon]}]` : '';
    this.logEvent(`${shooter}${wname} ▸ ${target}`, localIsShooter ? 'me' : localIsTarget ? 'dead' : undefined);
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
    this.setText(this.ammo, 'nuggets', String(n));
  }

  setScoreboardVisible(v: boolean): void {
    this.sbVisible = v;
    this.scoreboard.style.display = v ? 'block' : 'none';
    if (v) this.sbRefresh = 0; // force render on open
  }

  get scoreboardVisible(): boolean { return this.sbVisible; }

  setScoreboardRows(rows: { name: string; frags: number; score: number | null; ping: number | null; net?: string | null; self: boolean; dead: boolean; team?: 'alpha' | 'bravo'; sheep?: number | null }[]): void {
    this.sbData = rows;
  }

  private weaponSlots: HTMLSpanElement[] = [];
  private healthBar!: HTMLDivElement;
  private energyBar!: HTMLDivElement;
  private lastWeapon = '';
  // HUD abbreviations by weapon id (WEAPON_RATES / viewmodel order)
  private static readonly WEAPON_SHORT = ['BLT', 'DSG', 'CG', 'MTR', 'GL', 'FLK', 'PLM', 'RAIL', 'LG', 'SG', 'CAN', 'RKT'];
  // Last-rendered values — skip redundant DOM writes
  private lastText: Record<string, string> = {};
  private lastHealthPct = -1;
  private lastEnergyPct = -1;
  private lastFpsColor = '';
  private scoreboard: HTMLDivElement;
  private sbRows: HTMLElement;
  private sbVisible = false;
  private sbRefresh = 0;
  private sbData: { name: string; frags: number; score: number | null; ping: number | null; net?: string | null; self: boolean; dead: boolean; team?: 'alpha' | 'bravo'; sheep?: number | null }[] = [];

  showHitMarker(): void {
    this.hitTimer = 0.12;
    this.hitMarker.classList.add('visible');
  }

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
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;

  // Write text only when it changed — textContent assignment touches the DOM
  // even for identical strings
  private setText(el: HTMLElement, key: string, value: string): void {
    if (this.lastText[key] === value) return;
    this.lastText[key] = value;
    el.textContent = value;
  }

  /** Local player took damage — vignette pulse scaled to the hit, plus a
   *  directional arc pointing at the source when we know where it is. */
  showDamage(fromPos: THREE.Vector3 | null, damage: number): void {
    // Vignette: 10dmg ≈ subtle, 40+ ≈ strong. Stacking hits push opacity up
    // but cap below readability loss.
    this.dmgT = Math.min(1, this.dmgT + 0.18 + damage * 0.012);
    this.dmgVignette.style.opacity = String(Math.min(0.85, this.dmgT));

    if (fromPos) {
      // Bearing: world angle of (source - player) relative to facing.
      // forward = (sin yaw, cos yaw) on XZ; arc's 0° is screen-top.
      const dx = fromPos.x - this.lastPlayerPos.x;
      const dz = fromPos.z - this.lastPlayerPos.z;
      let rel = Math.atan2(dx, dz) - this.lastPlayerYaw;
      // Normalize to [-π, π], then flip: screen-right is -x when yaw=0
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      this.dmgDirArc.style.transform = `rotate(${-rel}rad)`;
      this.dmgDirT = 1;
      this.dmgDir.style.opacity = '1';
    }
  }

  /** Shielded hit — same directional language as showDamage but cyan and
   *  punchier: the bubble ate it, the energy bar is the real damage readout. */
  showShieldDamage(fromPos: THREE.Vector3 | null, damage: number): void {
    this.dmgT = Math.min(1, this.dmgT + 0.12 + damage * 0.008);
    this.dmgVignette.style.opacity = String(Math.min(0.6, this.dmgT));
    this.dmgVignette.style.boxShadow =
      'inset 0 0 18vmax rgba(90,200,255,0.55), inset 0 0 5vmax rgba(140,220,255,0.4)';
    // Restore the red shadow for the next real hit — showDamage resets it.
    clearTimeout(this.shieldVignetteReset);
    this.shieldVignetteReset = window.setTimeout(() => {
      this.dmgVignette.style.boxShadow = '';
    }, 300);
    if (fromPos) {
      const dx = fromPos.x - this.lastPlayerPos.x;
      const dz = fromPos.z - this.lastPlayerPos.z;
      let rel = Math.atan2(dx, dz) - this.lastPlayerYaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      this.dmgDirArc.style.transform = `rotate(${-rel}rad)`;
      this.dmgDirT = 1;
      this.dmgDir.style.opacity = '1';
    }
  }
  private shieldVignetteReset = 0;

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[], players?: Iterable<import('./minimap.js').MinimapPlayer>): void {
    this.minimap.update(targets, nuggets, pos, yaw, birds, players);
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.tickVitals(dt, player);
    this.tickBuffs(player);
    this.lastPlayerPos.copy(player.pos);
    this.lastPlayerYaw = player.yaw;
    this.tickDamageFx(dt);

    const nrg = Math.round(player.energy);
    this.setText(this.energy, 'energy', String(nrg));
    const energyPct = Math.round((nrg / 60) * 100);
    if (energyPct !== this.lastEnergyPct) {
      this.lastEnergyPct = energyPct;
      this.energyBar.style.width = `${energyPct}%`;
    }

    // Three readouts, all magnitude: |v| total, XZ horizontal, |vy|.
    this.setText(this.speed, 'speed', String(Math.round(player.vel.length())));
    this.setText(this.speedH, 'speedH', String(Math.round(player.getSpeed())));
    this.setText(this.speedV, 'speedV', String(Math.round(Math.abs(player.vel.y))));
    this.setText(this.kills, 'kills', String(player.kills));
    this.setText(this.state, 'state', player.onGround ? 'GROUND' : 'AIR');
    this.setText(this.ping, 'ping', String(Math.round(ping)));
    this.setText(this.loss, 'loss', String(Math.round(packetLoss)));
    this.setText(this.jitter, 'jitter', String(Math.round(jitter)));

    // Slots are loadout-driven: labels + highlight re-render only on change.
    const loadoutKey = player.loadout.join(',') + '|' + player.weaponIndex;
    if (loadoutKey !== this.lastWeapon) {
      this.lastWeapon = loadoutKey;
      player.loadout.forEach((wid, i) => {
        const s = this.weaponSlots[i];
        if (!s) return;
        s.textContent = `${i + 1} ${HUD.WEAPON_SHORT[wid] ?? '?'}`;
        s.classList.toggle('active', i === player.weaponIndex);
      });
    }

    this.updateFps(dt);

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitMarker.classList.remove('visible');
    }

    this.updateScoreboard(dt);
  }

  // Health text + bar with ghost-drain: damage leaves a trailing sliver
  // that bleeds down at ~40%/s so a hit reads as loss, not a snap.
  private tickVitals(dt: number, player: Player): void {
    // health is float (regen ticks at 12/s leave fractions) — the chip
    // shows whole hp or it prints 78.00000000000001.
    this.setText(this.health, 'health', String(Math.round(player.health)));
    const healthPct = Math.round(player.health);
    if (healthPct !== this.lastHealthPct) {
      this.lastHealthPct = healthPct;
      this.healthBar.style.width = `${healthPct}%`;
      // Damage → ghost holds the old width and drains down; heal → snap
      if (healthPct < this.ghostPct) {
        this.ghostBar.style.left = `${healthPct}%`;
        this.ghostBar.style.width = `${this.ghostPct - healthPct}%`;
      } else {
        this.ghostPct = healthPct;
        this.ghostBar.style.width = '0%';
      }
    }
    if (this.ghostPct > healthPct) {
      this.ghostPct = Math.max(healthPct, this.ghostPct - 40 * dt);
      this.ghostBar.style.left = `${healthPct}%`;
      this.ghostBar.style.width = `${this.ghostPct - healthPct}%`;
    }
    const armor = Math.round(player.armor);
    if (armor !== this.lastArmor) {
      this.lastArmor = armor;
      this.setText(this.armor, 'armor', String(armor));
      this.armorBar.style.width = `${armor}%`;
    }
  }

  // Timed buffs — chips with seconds left; rebuilt only on change.
  private tickBuffs(player: Player): void {
    const now = Date.now();
    const buffsKey = `${player.buffUntil.regen > now ? Math.ceil((player.buffUntil.regen - now) / 1000) : 0}|${player.buffUntil.dd > now ? Math.ceil((player.buffUntil.dd - now) / 1000) : 0}`;
    if (buffsKey === this.lastBuffsKey) return;
    this.lastBuffsKey = buffsKey;
    const chips: string[] = [];
    const [rs, ds] = buffsKey.split('|').map(Number);
    if (rs > 0) chips.push(`<span class="buff regen">REGEN ${rs}s</span>`);
    if (ds > 0) chips.push(`<span class="buff dd">2×DMG ${ds}s</span>`);
    this.buffsRow.innerHTML = chips.join('');
  }

  // Damage vignette decay (~0.7s to clear) + direction arc fade.
  private tickDamageFx(dt: number): void {
    if (this.dmgT > 0) {
      this.dmgT = Math.max(0, this.dmgT - dt * 1.4);
      this.dmgVignette.style.opacity = String(this.dmgT * 0.85);
    }
    if (this.dmgDirT > 0) {
      this.dmgDirT = Math.max(0, this.dmgDirT - dt * 1.1);
      this.dmgDir.style.opacity = String(this.dmgDirT);
    }
  }

  private updateFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.setText(this.fps, 'fps', String(this.fpsValue));
    const fpsColor =
      this.fpsValue < 40 ? '#f44' :
      this.fpsValue < 50 ? '#f80' :
      this.fpsValue < 59 ? '#ff4' : '#8cf';
    if (fpsColor !== this.lastFpsColor) {
      this.lastFpsColor = fpsColor;
      this.fps.style.color = fpsColor;
    }
  }

  // Scoreboard: rebuild rows at 4Hz while open (live ping/frags)
  private updateScoreboard(dt: number): void {
    if (!this.sbVisible) return;
    this.sbRefresh -= dt;
    if (this.sbRefresh <= 0) {
      this.sbRefresh = 0.25;
      // Any row carrying a team → split into sections; otherwise flat FFA.
      const hasTeams = this.sbData.some(r => r.team);
      if (!hasTeams) {
        this.sbRows.replaceChildren(...this.sbData.map(sbRowEl));
        return;
      }
      const kids: HTMLElement[] = [];
      for (const team of ['alpha', 'bravo'] as const) {
        const trs = this.sbData.filter(r => r.team === team).map(sbRowEl);
        if (!trs.length) continue;
        const th = document.createElement('tr');
        th.className = `sb-team ${team}`;
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = team.toUpperCase();
        th.appendChild(td);
        kids.push(th, ...trs);
      }
      // Teamless stragglers (spectators, unteamed) under their own header.
      const rest = this.sbData.filter(r => !r.team);
      if (rest.length) kids.push(...rest.map(sbRowEl));
      this.sbRows.replaceChildren(...kids);
    }
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
