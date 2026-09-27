import * as THREE from 'three';
import { Minimap } from './minimap.js';
import type { Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';

import { Player } from '../entities/Player.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('HUD');

// Scratch vectors for updatePlayerIndicator (runs per-player per-frame)
const _cameraPos = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _projected = new THREE.Vector3();

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
  private playerIndicators: Map<string, HTMLDivElement> = new Map();
  private playerList: HTMLDivElement;
  private ballCountEl: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private lastBallCount = -1;
  private lastTimerSec = -1;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #hud {
        position: absolute; inset: 0; pointer-events: none;
        user-select: none; -webkit-user-select: none;
        font-family: 'Courier New', monospace; color: #fff;
        text-shadow: 0 0 4px #000, 1px 1px 0 #000;
      }
      #hud-bc {
        position: absolute; bottom: 24px; left: 50%;
        transform: translateX(-50%);
        display: flex; flex-direction: column; gap: 5px;
        width: 300px;
        font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      }
      #hud-bc .labels {
        display: flex; justify-content: space-between;
        font-size: 0.7rem; letter-spacing: 0.15em;
        color: rgba(200,220,240,0.75); font-weight: 600;
      }
      #hud-bc .labels .v {
        color: #fff; font-weight: 700; font-size: 1.0rem;
        margin-left: 5px; font-variant-numeric: tabular-nums;
      }
      #hud-bc .bar-wrap {
        width: 100%; height: 8px;
        background: rgba(10,14,20,0.55);
        transform: skewX(-20deg);
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.12);
      }
      #hud-bc .bar-wrap.thin { height: 5px; }
      #hud-weapons {
        display: flex; justify-content: center; gap: 14px;
        font-size: 0.65rem; letter-spacing: 0.12em; font-weight: 600;
        color: rgba(160,180,200,0.45);
      }
      #hud-weapons .wslot { padding: 0 2px; }
      #hud-weapons .wslot.active {
        color: #fff;
        text-shadow: 0 0 6px rgba(140,220,255,0.9);
      }
      #hud-bc .bar-fill {
        height: 100%; width: 100%;
        transition: width 0.08s;
      }
      #health-bar { background: linear-gradient(90deg, #e33, #f77); box-shadow: 0 0 6px rgba(255,80,80,0.5); }
      #energy-bar { background: linear-gradient(90deg, #0af, #7df); box-shadow: 0 0 6px rgba(80,180,255,0.5); }
      #hud-tr {
        position: absolute; top: 14px; right: 20px;
        font-size: 0.75rem; color: #8cf; text-align: right;
        line-height: 1.7;
      }
      #hud-fps {
        position: absolute; top: 44px; right: 20px;
        font-size: 2.2rem; font-weight: bold; color: #8cf;
        text-align: right; line-height: 1;
      }
      #ball-count {
        position: fixed; bottom: 24px; left: 24px;
        font-size: 1.4rem; font-weight: bold; color: #fc8;
        font-variant-numeric: tabular-nums;
      }
      #hud-timer {
        position: absolute; top: 14px; left: 50%;
        transform: translateX(-50%);
        font-size: 1.5rem; font-weight: bold; color: #ffd9a0;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 0 6px rgba(0,0,0,0.8), 1px 1px 0 #000;
      }
      #hud-tl {
        position: absolute; top: 14px; left: 20px;
        font-size: 0.75rem; color: #ccc; line-height: 1.7;
      }
      #crosshair {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 5px; height: 5px;
        background: rgba(255,255,255,0.9);
        border-radius: 50%;
        box-shadow: 0 0 3px rgba(0,0,0,0.8);
      }
      #hit-marker {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 0; height: 0; opacity: 0;
        transition: opacity 0.05s;
      }
      #hit-marker::before, #hit-marker::after {
        content: ''; position: absolute;
        background: #fff; width: 3px; height: 22px;
        top: -11px; left: -1px;
        border-radius: 1px;
      }
      #hit-marker::before { transform: rotate(45deg); }
      #hit-marker::after  { transform: rotate(-45deg); }
      #hit-marker.visible { opacity: 1; }

      .player-indicator {
        position: absolute;
        width: 12px;
        height: 12px;
        background: #f44;
        border: 2px solid #fff;
        border-radius: 50%;
        pointer-events: none;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 8px rgba(255, 68, 68, 0.8);
        transition: opacity 0.1s;
      }
      .player-indicator-offscreen {
        width: 12px !important;
        height: 12px !important;
      }
      .player-indicator.offscreen {
        background: transparent;
        border-color: #f00;
      }
      .player-indicator.hidden {
        opacity: 0;
      }
      #player-list {
        position: absolute; top: 14px; left: 20px;
        font-size: 0.75rem; color: #ccc; line-height: 1.7;
        text-align: left;
      }
      #player-list .player-id {
        display: block;
        margin-bottom: 2px;
      }
      #player-list .player-id.local {
        color: #0f0;
        font-weight: bold;
      }
      #player-list .player-id.remote {
        color: #ccc;
      }
      #scoreboard {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        min-width: 340px;
        background: rgba(8,12,18,0.85);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 8px;
        padding: 14px 18px;
        font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        display: none;
      }
      #scoreboard .sb-title {
        font-size: 0.65rem; letter-spacing: 0.25em;
        color: rgba(200,220,240,0.5); font-weight: 600;
        text-align: center; margin-bottom: 10px;
      }
      #scoreboard table {
        width: 100%; border-collapse: collapse;
        font-size: 0.85rem; color: #dde;
        font-variant-numeric: tabular-nums;
      }
      #scoreboard th {
        font-size: 0.6rem; letter-spacing: 0.15em; font-weight: 600;
        color: rgba(200,220,240,0.5); text-align: left;
        padding: 0 14px 6px 0;
      }
      #scoreboard th:last-child, #scoreboard td:last-child { text-align: right; padding-right: 0; }
      #scoreboard td { padding: 3px 14px 3px 0; }
      #scoreboard td:last-child { text-align: right; }
      #scoreboard tr.self td { color: #8fd8ff; font-weight: 600; }
      #scoreboard tr.dead td { opacity: 0.45; }
    `;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="player-list"></div>
      <div id="hud-tr">
        Speed: <span id="spd">0</span> &nbsp; <span id="state-lbl">GROUND</span> &nbsp; Ping: <span id="ping">0</span>ms &nbsp; Loss: <span id="loss">0</span>% &nbsp; Jitter: <span id="jitter">0</span>ms
      </div>
      <div id="hud-fps"><span id="fps">0</span></div>
      <div id="hud-bc">
        <div id="hud-weapons">
          <span class="wslot" data-w="0">1 BLT</span>
          <span class="wslot" data-w="1">2 DSG</span>
          <span class="wslot" data-w="2">3 CG</span>
          <span class="wslot" data-w="3">4 MTR</span>
          <span class="wslot" data-w="4">5 GL</span>
          <span class="wslot" data-w="5">6 FLK</span>
          <span class="wslot" data-w="6">7 PLM</span>
        </div>
        <div class="labels">
          <span>HEALTH<span class="v" id="hp">100</span></span>
          <span>NUGGETS<span class="v" id="ammo">0</span></span>
        </div>
        <div class="labels">
          <span>ENERGY<span class="v" id="nrg">60</span></span>
          <span>KILLS<span class="v" id="kills">0</span></span>
        </div>
        <div class="bar-wrap"><div class="bar-fill" id="health-bar"></div></div>
        <div class="bar-wrap thin"><div class="bar-fill" id="energy-bar"></div></div>
      </div>
      <div id="crosshair"></div>
      <div id="hit-marker"></div>
      <div id="ball-count">0</div>
      <div id="hud-timer">00:00</div>
      <div id="scoreboard">
        <div class="sb-title">SCOREBOARD</div>
        <table><thead><tr><th>PLAYER</th><th>FRAGS</th><th>PING</th></tr></thead><tbody id="sb-rows"></tbody></table>
      </div>
    `;
    document.body.appendChild(this.el);

    this.health   = this.el.querySelector('#hp')!;
    this.energy   = this.el.querySelector('#nrg')!;
    this.ammo     = this.el.querySelector('#ammo')!;
    this.speed    = this.el.querySelector('#spd')!;
    this.kills    = this.el.querySelector('#kills')!;
    this.state    = this.el.querySelector('#state-lbl')!;
    this.ping     = this.el.querySelector('#ping')!;
    this.loss     = this.el.querySelector('#loss')!;
    this.jitter   = this.el.querySelector('#jitter')!;
    this.fps      = this.el.querySelector('#fps')!;
    this.crosshair = this.el.querySelector('#crosshair')!;
    this.minimap = new Minimap(this.el);
    this.playerList = this.el.querySelector('#player-list')!;
    this.hitMarker = this.el.querySelector('#hit-marker')!;
    this.weaponSlots = Array.from(this.el.querySelectorAll('.wslot'));
    this.healthBar = this.el.querySelector('#health-bar') as HTMLDivElement;
    this.energyBar = this.el.querySelector('#energy-bar') as HTMLDivElement;
    // Nugget counter — starts at 0, updated via setNuggets
    this.ammo.textContent = '0';
    this.ammo.style.color = '#ffd54a'; // gold, matching the pickup
    this.scoreboard = this.el.querySelector('#scoreboard')!;
    this.sbRows = this.el.querySelector('#sb-rows')!;
    this.ballCountEl = this.el.querySelector('#ball-count')!;
    this.timerEl = this.el.querySelector('#hud-timer')!;
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
  private lastWeapon = -1;
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

  updateMinimap(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number): void {
    this.minimap.update(targets, nuggets, pos, yaw);
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.setText(this.health, 'health', String(player.health));
    const healthPct = Math.round(player.health);
    if (healthPct !== this.lastHealthPct) {
      this.lastHealthPct = healthPct;
      this.healthBar.style.width = `${healthPct}%`;
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

    if (player.weaponIndex !== this.lastWeapon) {
      this.lastWeapon = player.weaponIndex;
      this.weaponSlots.forEach((s, i) => s.classList.toggle('active', i === player.weaponIndex));
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
    let indicator = this.playerIndicators.get(playerId);
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'player-indicator';
      this.el.appendChild(indicator);
      this.playerIndicators.set(playerId, indicator);
      logger.debug(`INDICATOR CREATED`, { playerId, total: this.playerIndicators.size });
    }

    if (isDead) {
      indicator.classList.add('hidden');
      return;
    } else {
      indicator.classList.remove('hidden');
    }

    // Get camera position and direction (module scratch — no per-call allocs)
    camera.getWorldPosition(_cameraPos);
    camera.getWorldDirection(_cameraDir);

    // Calculate vector from camera to target
    // Position is at feet, but we want to point to the player center (feet + 1.0)
    const targetPos = _targetPos.set(position.x, position.y + 1.0, position.z);
    const toTarget = _toTarget.subVectors(targetPos, _cameraPos);

    // Check if target is behind camera (angle > 90 degrees)
    const behind = toTarget.angleTo(_cameraDir) > Math.PI / 2;

    // Project 3D position to 2D screen space
    const vector = _projected.copy(targetPos);
    vector.project(camera);

    let x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    let y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;

    // If behind camera, invert coordinates
    if (behind) {
      x = window.innerWidth - x;
      y = window.innerHeight - y;
    }

    // Check if player is on screen
    const onScreen = !behind && x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;

    indicator.classList.remove('hidden');

    if (onScreen) {
      // Player is visible on screen - show indicator at actual position
      indicator.classList.remove('offscreen');
      // Scale dot by inverse square root of distance (gentler than 1/d)
      const distance = _cameraPos.distanceTo(targetPos);
      const REF_DIST = 50;
      const MIN_SIZE = 6;
      const MAX_SIZE = 12;
      const scale = REF_DIST / Math.sqrt(Math.max(distance, 1));
      const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, 12 * scale));
      indicator.style.width = `${size}px`;
      indicator.style.height = `${size}px`;
      indicator.style.left = `${x}px`;
      indicator.style.top = `${y}px`;
    } else {
      // Player is off-screen - show indicator at screen edge
      indicator.classList.add('offscreen');

      // Calculate direction from center of screen to player
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const dx = x - centerX;
      const dy = y - centerY;
      const angle = Math.atan2(dy, dx);

      // Clamp to screen edge using proper edge calculation
      const margin = 40;
      const halfWidth = window.innerWidth / 2 - margin;
      const halfHeight = window.innerHeight / 2 - margin;

      // Calculate distance to each edge
      const distWidth = halfWidth / Math.abs(Math.cos(angle));
      const distHeight = halfHeight / Math.abs(Math.sin(angle));
      const dist = Math.min(distWidth, distHeight);

      const clampedX = centerX + Math.cos(angle) * dist;
      const clampedY = centerY + Math.sin(angle) * dist;

      indicator.style.left = `${clampedX}px`;
      indicator.style.top = `${clampedY}px`;
    }
  }

  removePlayerIndicator(playerId: string): void {
    const indicator = this.playerIndicators.get(playerId);
    if (indicator) {
      indicator.remove();
      this.playerIndicators.delete(playerId);
      logger.debug(`INDICATOR REMOVED`, { playerId, total: this.playerIndicators.size });
    } else {
      // Indicator already removed - this is called every frame for dead players
    }
  }

  clearPlayerIndicators(): void {
    this.playerIndicators.forEach(indicator => indicator.remove());
    this.playerIndicators.clear();
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
