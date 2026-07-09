import * as THREE from 'three';

import { MAX_HEALTH, PLAYER_HEIGHT, BALL_BASE_RADIUS } from '../core/config.js';

import { Ball } from '../entities/balls.js';

interface HealthBar {
  playerId?: string;
  ball?: Ball;
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
  private ballBars: Map<Ball, HealthBar> = new Map();
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
    const bar = this.bars.get(playerId);
    if (bar) {
      this.resetBar(bar, damage, health);
      return;
    }
    this.bars.set(playerId, this.createHealthBar(damage, health, MAX_HEALTH, playerId));
  }

  spawnBall(ball: Ball, damage: number, health: number): void {
    const bar = this.ballBars.get(ball);
    if (bar) {
      this.resetBar(bar, damage, health);
      return;
    }
    this.ballBars.set(ball, this.createHealthBar(damage, health, 3, undefined, ball));
  }

  predictDamage(playerId: string, damage: number): void {
    const bar = this.bars.get(playerId);
    if (bar) {
      this.resetBar(bar, damage, Math.max(0, bar.currentHealth - damage));
      return;
    }
    // No existing bar — spawn with predicted health
    this.spawn(playerId, damage, Math.max(0, MAX_HEALTH - damage));
  }

  update(dt: number, players: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean }>, remotePlayers?: Map<string, { position: THREE.Vector3; isDead: boolean }>, _balls?: Ball[]): void {
    const cameraPos = new THREE.Vector3();
    this.camera.getWorldPosition(cameraPos);
    const cameraDir = new THREE.Vector3();
    this.camera.getWorldDirection(cameraDir);

    // Update player healthbars
    for (const [playerId, bar] of this.bars) {
      const playerState = players.get(playerId);
      const rp = remotePlayers?.get(playerId);
      const isDead = rp ? rp.isDead : (playerState?.isDead ?? true);

      if (!playerState || isDead) {
        this.removeBar(playerId);
        continue;
      }

      const pos = rp ? rp.position : playerState.position;
      const targetPos = new THREE.Vector3(pos.x, pos.y + PLAYER_HEIGHT + 0.3, pos.z);
      this.updateBar(bar, dt, targetPos, cameraPos, cameraDir, () => this.removeBar(playerId));
    }

    // Update ball healthbars
    for (const [ball, bar] of this.ballBars) {
      if (ball.dead) {
        this.removeBallBar(ball);
        continue;
      }
      const targetPos = new THREE.Vector3(
        ball.pos.x,
        ball.pos.y + ball.scale * BALL_BASE_RADIUS + 0.5,
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

  removeBallBar(ball: Ball): void {
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
    ball?: Ball
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
    } else {
      bar.whiteEl.style.display = 'none';
    }

    // No opacity fade — bar stays fully visible until life expires (matches OG behavior)

    const toTarget = new THREE.Vector3().subVectors(targetPos, cameraPos);
    const behind = toTarget.angleTo(cameraDir) > Math.PI / 2;

    const projected = targetPos.clone();
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
    bar.el.style.left = `${x}px`;
    bar.el.style.top = `${y}px`;
  }
}
