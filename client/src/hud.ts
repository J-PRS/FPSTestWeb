import * as THREE from 'three';
import { Player } from './Player.js';

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
  private crosshair: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private hitTimer = 0;
  private playerIndicators: Map<string, HTMLDivElement> = new Map();
  private playerList: HTMLDivElement;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #hud {
        position: absolute; inset: 0; pointer-events: none;
        font-family: 'Courier New', monospace; color: #fff;
        text-shadow: 0 0 4px #000, 1px 1px 0 #000;
      }
      #hud-bl {
        position: absolute; bottom: 20px; left: 20px;
        display: flex; flex-direction: column; gap: 4px;
        font-size: 0.85rem;
      }
      #hud-bl .row { display: flex; gap: 12px; align-items: center; }
      #hud-bl .label { color: #adf; font-size: 0.72rem; letter-spacing: 0.08em; }
      #hud-bl .val { font-size: 1.0rem; font-weight: bold; min-width: 48px; }
      #hud-tr {
        position: absolute; top: 14px; right: 20px;
        font-size: 0.75rem; color: #8cf; text-align: right;
        line-height: 1.7;
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
      .energy-bar-wrap {
        width: 140px; height: 6px; background: rgba(255,255,255,0.15);
        border-radius: 3px; overflow: hidden; margin-top: 2px;
      }
      #energy-bar {
        height: 100%; width: 100%;
        background: linear-gradient(90deg, #0af, #08f);
        border-radius: 3px;
        transition: width 0.05s;
      }
      #health-bar-wrap {
        width: 140px; height: 6px; background: rgba(255,255,255,0.15);
        border-radius: 3px; overflow: hidden; margin-top: 2px;
      }
      #health-bar {
        height: 100%; width: 100%;
        background: linear-gradient(90deg, #f44, #f88);
        border-radius: 3px;
        transition: width 0.1s;
      }
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
    `;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="player-list"></div>
      <div id="hud-tr">
        Speed: <span id="spd">0</span> &nbsp; <span id="state-lbl">GROUND</span> &nbsp; Ping: <span id="ping">0</span>ms &nbsp; Loss: <span id="loss">0</span>% &nbsp; Jitter: <span id="jitter">0</span>ms
      </div>
      <div id="hud-bl">
        <div class="row">
          <span class="label">HP</span>
          <span class="val" id="hp">100</span>
        </div>
        <div class="energy-bar-wrap" style="margin-bottom:2px">
          <div id="health-bar"></div>
        </div>
        <div class="row">
          <span class="label">ENERGY</span>
          <span class="val" id="nrg">60</span>
        </div>
        <div class="energy-bar-wrap">
          <div id="energy-bar"></div>
        </div>
        <div class="row" style="margin-top:6px">
          <span class="label">AMMO</span>
          <span class="val" id="ammo">10/10</span>
          &nbsp;
          <span class="label">KILLS</span>
          <span class="val" id="kills">0</span>
        </div>
      </div>
      <div id="crosshair"></div>
      <div id="hit-marker"></div>
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
    this.crosshair = this.el.querySelector('#crosshair')!;
    this.playerList = this.el.querySelector('#player-list')!;
    this.hitMarker = this.el.querySelector('#hit-marker')!;
  }

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

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.health.textContent = String(player.health);
    (this.el.querySelector('#health-bar') as HTMLDivElement).style.width =
      `${(player.health / 100) * 100}%`;

    const nrg = Math.round(player.energy);
    this.energy.textContent = String(nrg);
    (this.el.querySelector('#energy-bar') as HTMLDivElement).style.width =
      `${(nrg / 60) * 100}%`;

    this.ammo.textContent = '∞';
    (this.ammo as HTMLElement).style.color = '#4f4';

    this.speed.textContent  = String(Math.round(player.getSpeed()));
    this.kills.textContent  = String(player.kills);
    this.state.textContent  = player.onGround ? 'GROUND' : 'AIR';
    this.ping.textContent   = String(Math.round(ping));
    this.loss.textContent   = String(Math.round(packetLoss));
    this.jitter.textContent = String(Math.round(jitter));

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitMarker.classList.remove('visible');
    }
  }

  updatePlayerIndicator(playerId: string, position: { x: number; y: number; z: number }, camera: any, isDead: boolean = false): void {
    let indicator = this.playerIndicators.get(playerId);
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'player-indicator';
      this.el.appendChild(indicator);
      this.playerIndicators.set(playerId, indicator);
      console.log(`[HUD] INDICATOR CREATED for playerId=${playerId} (total indicators: ${this.playerIndicators.size})`);
    }

    if (isDead) {
      indicator.classList.add('hidden');
      return;
    } else {
      indicator.classList.remove('hidden');
    }

    // Get camera position and direction
    const cameraPos = new THREE.Vector3();
    camera.getWorldPosition(cameraPos);
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);

    // Calculate vector from camera to target
    // Position is at feet, but we want to point to the player center (feet + 1.0)
    const targetPos = new THREE.Vector3(position.x, position.y + 1.0, position.z);
    const toTarget = new THREE.Vector3().subVectors(targetPos, cameraPos);

    // Check if target is behind camera (angle > 90 degrees)
    const behind = toTarget.angleTo(cameraDir) > Math.PI / 2;

    // Project 3D position to 2D screen space
    const vector = targetPos.clone();
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
      console.log(`[HUD] INDICATOR REMOVED for playerId=${playerId} (total indicators: ${this.playerIndicators.size})`);
    } else {
      console.log(`[HUD] INDICATOR NOT FOUND for removal, playerId=${playerId}`);
    }
  }

  clearPlayerIndicators(): void {
    this.playerIndicators.forEach(indicator => indicator.remove());
    this.playerIndicators.clear();
  }

  updatePlayerList(playerIds: string[], localPlayerId: string): void {
    this.playerList.innerHTML = '';
    playerIds.forEach(playerId => {
      const div = document.createElement('div');
      div.className = playerId === localPlayerId ? 'player-id local' : 'player-id remote';
      div.textContent = playerId;
      this.playerList.appendChild(div);
    });
  }
}
