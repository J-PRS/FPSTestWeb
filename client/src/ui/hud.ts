import * as THREE from 'three';
import { Minimap } from './minimap.js';
import { createHudDom } from './hud/dom.js';
import { PlayerIndicators } from './hud/indicators.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';

import { Player } from '../entities/Player.js';

export class HUD {
  private el: HTMLDivElement;
  private health: HTMLSpanElement;
  private energy: HTMLSpanElement;
  private ammo: HTMLSpanElement;
  private speed: HTMLSpanElement;
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

  constructor() {
    const d = createHudDom();
    this.el = d.el;
    this.health = d.health;
    this.energy = d.energy;
    this.ammo = d.ammo;
    this.speed = d.speed;
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
    this.scoreboard = d.scoreboard;
    this.sbRows = d.sbRows;
    this.teamScore = d.teamScore;
    this.tsA = d.tsA;
    this.tsB = d.tsB;
    this.minimap = new Minimap(this.el);
    this.indicators = new PlayerIndicators(this.el);
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
    const num = (n: number) => `<span class="${n > 0 ? 'hot' : 'dim'}">${n}</span>`;
    this.ballCountEl.innerHTML =
      `<span class="dim">balls</span> ${num(c.balls)}${c.elites ? ` <span class="dim">+elite</span> ${num(c.elites)}` : ''}` +
      ` <span class="dim">tgt</span> ${num(c.targets)} <span class="dim">fodder</span> ${num(fodder)} <span class="dim">(scr ${c.scarabs} grb ${c.grubs} gnt ${c.gnats})</span>\n` +
      `<span class="dim">hunt</span> ${num(hunters)} <span class="dim">(crw ${c.crawlers} snk ${c.snakes} sek ${c.seekers} rak ${c.rakks} bld ${c.rollers})</span>\n` +
      `<span class="dim">siege</span> ${num(siegers)} <span class="dim">(tur ${c.turrets} ovl ${c.overlords} tot ${c.totems}) mine ${c.mines} · proj ${c.projectiles} fx ${c.fx}</span>`;
  }
  private lastCountsKey = '';

  /** Nugget Wars team totals — shown only while the mode runs. */
  setTeamScore(a: number, b: number): void {
    this.teamScore.style.display = 'block';
    this.tsA.textContent = String(a);
    this.tsB.textContent = String(b);
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

  setScoreboardRows(rows: { name: string; frags: number; ping: number | null; self: boolean; dead: boolean }[]): void {
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
  private sbData: { name: string; frags: number; ping: number | null; self: boolean; dead: boolean }[] = [];

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

  setDeathOverlay(on: boolean): void {
    if (on && !this.deathOverlay) {
      const d = document.createElement('div');
      d.style.cssText = `
        position:absolute; inset:0; pointer-events:none; z-index:5;
        background: radial-gradient(ellipse at center,
          rgba(0,0,0,0) 40%, rgba(0,0,0,0.25) 70%, rgba(0,0,0,0.6) 100%);
        backdrop-filter: grayscale(0.7) brightness(0.85);
        -webkit-backdrop-filter: grayscale(0.7) brightness(0.85);
      `;
      document.body.appendChild(d);
      this.deathOverlay = d;
    } else if (!on && this.deathOverlay) {
      this.deathOverlay.remove();
      this.deathOverlay = null;
    }
  }

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

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[]): void {
    this.minimap.update(targets, nuggets, pos, yaw, birds);
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.setText(this.health, 'health', String(player.health));
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
    // Ghost drains toward the real fill at ~40%/s
    if (this.ghostPct > healthPct) {
      this.ghostPct = Math.max(healthPct, this.ghostPct - 40 * dt);
      this.ghostBar.style.left = `${healthPct}%`;
      this.ghostBar.style.width = `${this.ghostPct - healthPct}%`;
    }

    this.lastPlayerPos.copy(player.pos);
    this.lastPlayerYaw = player.yaw;

    // Damage vignette decay (~0.7s to clear) + direction arc fade
    if (this.dmgT > 0) {
      this.dmgT = Math.max(0, this.dmgT - dt * 1.4);
      this.dmgVignette.style.opacity = String(this.dmgT * 0.85);
    }
    if (this.dmgDirT > 0) {
      this.dmgDirT = Math.max(0, this.dmgDirT - dt * 1.1);
      this.dmgDir.style.opacity = String(this.dmgDirT);
    }

    const nrg = Math.round(player.energy);
    this.setText(this.energy, 'energy', String(nrg));
    const energyPct = Math.round((nrg / 60) * 100);
    if (energyPct !== this.lastEnergyPct) {
      this.lastEnergyPct = energyPct;
      this.energyBar.style.width = `${energyPct}%`;
    }

    this.setText(this.speed, 'speed', String(Math.round(player.getSpeed())));
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
      // textContent, not innerHTML — display names will be player-chosen
      // strings; interpolating them raw is a stored-XSS hole in waiting.
      this.sbRows.replaceChildren(...this.sbData.map(r => {
        const tr = document.createElement('tr');
        tr.className = `${r.self ? 'self' : ''}${r.dead ? ' dead' : ''}`;
        for (const cell of [r.name, String(r.frags), r.ping === null ? '—' : String(Math.round(r.ping))]) {
          const td = document.createElement('td');
          td.textContent = cell;
          tr.appendChild(td);
        }
        return tr;
      }));
    }
  }

  updatePlayerIndicator(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, isDead: boolean = false): void {
    this.indicators.update(playerId, position, camera, isDead);
  }

  removePlayerIndicator(playerId: string): void {
    this.indicators.remove(playerId);
  }

  clearPlayerIndicators(): void {
    this.indicators.clear();
  }

  private lastPlayerListKey = '';

  updatePlayerList(playerIds: string[], localPlayerId: string): void {
    // Roster changes are rare; rebuilding DOM every frame (60Hz) was pure churn
    const key = playerIds.join('');
    if (key === this.lastPlayerListKey) return;
    this.lastPlayerListKey = key;
    this.playerList.innerHTML = '';
    playerIds.forEach(playerId => {
      const div = document.createElement('div');
      div.className = playerId === localPlayerId ? 'player-id local' : 'player-id remote';
      div.textContent = playerId;
      this.playerList.appendChild(div);
    });
  }
}
