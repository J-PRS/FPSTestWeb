import * as THREE from 'three';

import { MAX_HEALTH, PLAYER_HEIGHT } from '../core/config.js';

import { Ball, Targetable } from '../entities/balls.js';

// Scratch vectors — update() iterates bars sequentially, safe to share
const _cameraPos = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _projected = new THREE.Vector3();

interface HealthBar {
  playerId?: string;
  ball?: Targetable;
  damage: number;
  flashTimer: number;
  delayTimer: number;
  life: number;
  maxHealth: number;
  currentHealth: number;
  el: HTMLDivElement;
  bgEl: HTMLDivElement;
  healthEl: HTMLDivElement;
  whiteEl: HTMLDivElement;
}

const BAR_WIDTH = 40;
const BAR_HEIGHT = 5;
const FLASH_DURATION = 0.12;
const DELAY_DURATION = 0.3;
const BAR_LIFETIME = 1.5;

export class HealthBarSystem {
  private bars: Map<string, HealthBar> = new Map();
  private ballBars: Map<Targetable, HealthBar> = new Map();
  // Last authoritative health per player — persists beyond bar lifetime so
  // damage predictions accumulate across hits spaced wider than BAR_LIFETIME
  private knownHealth: Map<string, number> = new Map();
  private container: HTMLDivElement;
  private camera: THREE.Camera;

  constructor(camera: THREE.Camera) {
    this.camera = camera;

    const style = document.createElement('style');
    style.textContent = `
      #healthbar-container {
        position: absolute; inset: 0; pointer-events: none; overflow: hidden;
      }
      .enemy-hpbar {
        position: absolute;
        width: ${BAR_WIDTH}px;
        height: ${BAR_HEIGHT}px;
        transform: translate(-50%, -50%);
        display: none;
      }
      .enemy-hpbar .bg {
        position: absolute; inset: 0;
        background: rgba(217, 38, 38, 0.2);
        border-radius: 1px;
      }
      .enemy-hpbar .health {
        position: absolute; top: 0; left: 0; height: 100%;
        background: rgba(217, 38, 38, 0.9);
        border-radius: 1px;
      }
      .enemy-hpbar .white {
        position: absolute; top: 0; left: 0; height: 100%;
        background: rgba(255, 255, 255, 1.0);
        border-radius: 1px;
        display: none;
      }
    `;
    document.head.appendChild(style);

    this.container = document.createElement('div');
    this.container.id = 'healthbar-container';
    document.body.appendChild(this.container);
  }

  spawn(playerId: string, damage: number, health: number): void {
    this.upsertBar(playerId, damage, health);
  }

  spawnBall(ball: Targetable, damage: number, health: number): void {
    const bar = this.ballBars.get(ball);
    if (bar) {
      this.resetBar(bar, damage, health);
      return;
    }
    this.ballBars.set(ball, this.createHealthBar(damage, health, ball.maxHealth ?? 3, undefined, ball));
  }

  predictDamage(playerId: string, damage: number): void {
    const bar = this.bars.get(playerId);
    const base = bar ? bar.currentHealth : (this.knownHealth.get(playerId) ?? MAX_HEALTH);
    const health = Math.max(0, base - damage);
    this.upsertBar(playerId, damage, health);
  }

  private upsertBar(playerId: string, damage: number, health: number): void {
    this.knownHealth.set(playerId, health);
    const bar = this.bars.get(playerId);
    if (bar) {
      this.resetBar(bar, damage, health);
      return;
    }
    this.bars.set(playerId, this.createHealthBar(damage, health, MAX_HEALTH, playerId));
  }

  update(dt: number, players: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean; health?: number }>, remotePlayers?: Map<string, { position: THREE.Vector3; isDead: boolean }>, _balls?: Ball[]): void {
    // Sync authoritative health from the server-fed player map (20Hz
    // tickUpdate + playerHit) — keeps predictions anchored even while bars
    // are dormant, and self-heals on respawn (health back to max).
    for (const [playerId, state] of players) {
      if (state.health !== undefined) this.knownHealth.set(playerId, state.health);
    }

    const cameraPos = _cameraPos;
    this.camera.getWorldPosition(cameraPos);
    const cameraDir = _cameraDir;
    this.camera.getWorldDirection(cameraDir);

    // Update player healthbars
    for (const [playerId, bar] of this.bars) {
      const playerState = players.get(playerId);
      const rp = remotePlayers?.get(playerId);
      // Local bots ('bot:', 'BOT-') have a rendered body but no wire-roster
      // entry — a live rp is sufficient authority for the bar.
      if ((!playerState && !rp) || rp?.isDead || playerState?.isDead) {
        this.removeBar(playerId);
        continue;
      }

      const pos = rp ? rp.position : playerState!.position;
      const targetPos = _targetPos.set(pos.x, pos.y + PLAYER_HEIGHT + 0.3, pos.z);
      this.updateBar(bar, dt, targetPos, cameraPos, cameraDir, () => this.removeBar(playerId));
    }

    // Update ball healthbars
    for (const [ball, bar] of this.ballBars) {
      if (ball.dead) {
        this.removeBallBar(ball);
        continue;
      }
      const targetPos = _targetPos.set(
        ball.pos.x,
        ball.pos.y + ball.radius + 0.5,
        ball.pos.z
      );
      this.updateBar(bar, dt, targetPos, cameraPos, cameraDir, () => this.removeBallBar(ball));
    }
  }

  removeBar(playerId: string): void {
    const bar = this.bars.get(playerId);
    if (bar) {
      bar.el.remove();
      this.bars.delete(playerId);
    }
  }

  removeBallBar(ball: Targetable): void {
    const bar = this.ballBars.get(ball);
    if (bar) {
      bar.el.remove();
      this.ballBars.delete(ball);
    }
  }

  clear(): void {
    for (const [, bar] of this.bars) {
      bar.el.remove();
    }
    this.bars.clear();
    for (const [, bar] of this.ballBars) {
      bar.el.remove();
    }
    this.ballBars.clear();
    this.knownHealth.clear();
  }

  private createBarEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'enemy-hpbar';
    el.innerHTML = '<div class="bg"></div><div class="health"></div><div class="white"></div>';
    this.container.appendChild(el);
    return el;
  }

  private createHealthBar(
    damage: number,
    health: number,
    maxHealth: number,
    playerId?: string,
    ball?: Targetable
  ): HealthBar {
    const el = this.createBarEl();
    return {
      playerId,
      ball,
      damage,
      flashTimer: FLASH_DURATION,
      delayTimer: DELAY_DURATION,
      life: BAR_LIFETIME,
      maxHealth,
      currentHealth: health,
      el,
      bgEl: el.querySelector('.bg')!,
      healthEl: el.querySelector('.health')!,
      whiteEl: el.querySelector('.white')!,
    };
  }

  private resetBar(bar: HealthBar, damage: number, health: number): void {
    if (bar.delayTimer > 0) {
      bar.damage += damage;
    } else {
      bar.damage = damage;
    }
    bar.flashTimer = FLASH_DURATION;
    bar.delayTimer = DELAY_DURATION;
    bar.life = BAR_LIFETIME;
    bar.currentHealth = health;
    bar.el.style.display = 'block';
  }

  private updateBar(
    bar: HealthBar,
    dt: number,
    targetPos: THREE.Vector3,
    cameraPos: THREE.Vector3,
    cameraDir: THREE.Vector3,
    removeBar: () => void
  ): void {
    bar.life -= dt;
    if (bar.life <= 0) {
      removeBar();
      return;
    }

    if (bar.delayTimer > 0) {
      bar.delayTimer -= dt;
    } else if (bar.flashTimer > 0) {
      bar.flashTimer -= dt;
    }

    const healthRatio = Math.max(0, Math.min(1, bar.currentHealth / bar.maxHealth));
    const damageRatio = Math.min(1 - healthRatio, bar.damage / bar.maxHealth);

    bar.healthEl.style.width = `${BAR_WIDTH * healthRatio}px`;

    if ((bar.flashTimer > 0 || bar.delayTimer > 0) && damageRatio > 0) {
      let whiteWidth: number;
      if (bar.delayTimer > 0) {
        whiteWidth = BAR_WIDTH * damageRatio;
      } else {
        const flash = Math.max(0, Math.min(1, bar.flashTimer / FLASH_DURATION));
        whiteWidth = BAR_WIDTH * damageRatio * flash;
      }
      bar.whiteEl.style.display = 'block';
      bar.whiteEl.style.width = `${whiteWidth}px`;
      bar.whiteEl.style.left = `${BAR_WIDTH * healthRatio}px`;
    } else if (bar.whiteEl.style.display !== 'none') {
      bar.whiteEl.style.display = 'none';
    }

    const toTarget = _toTarget.subVectors(targetPos, cameraPos);
    const behind = toTarget.angleTo(cameraDir) > Math.PI / 2;

    const projected = _projected.copy(targetPos);
    projected.project(this.camera);

    if (behind) {
      bar.el.style.display = 'none';
      return;
    }

    const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-(projected.y * 0.5) + 0.5) * window.innerHeight;

    const onScreen = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
    if (!onScreen) {
      bar.el.style.display = 'none';
      return;
    }

    bar.el.style.display = 'block';
    // transform positioning — compositor-only, no layout work per frame
    bar.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}
