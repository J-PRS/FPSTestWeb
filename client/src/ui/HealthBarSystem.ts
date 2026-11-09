import * as THREE from 'three';

import { MAX_HEALTH } from '../core/config.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import { REPAIR_ARMOR_MULT } from '../../../shared/weapons.js';

import type { Ball, Targetable } from '../entities/balls.js';
import { ndcToClient } from './ndcScreen.js';

// Scratch vectors - update() iterates bars sequentially, safe to share
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
  currentArmor: number;
  el: HTMLDivElement;
  bgEl: HTMLDivElement;
  healthEl: HTMLDivElement;
  armorEl: HTMLDivElement;
  whiteEl: HTMLDivElement;
}

const BAR_WIDTH = 40;
const BAR_HEIGHT = 5;
const FLASH_DURATION = 0.12;
const DELAY_DURATION = 0.3;
const BAR_LIFETIME = 5; // hit-popup linger — a wounded readout, not a flash
const REPAIR_LINGER = 0.4; // weld bar outlives the beam by a beat — no flicker between ticks

/** Structural repair target — deployables.ts Item satisfies this; kept
 *  structural so ui/ doesn't import the game module. */
export interface RepairTarget {
  pos: THREE.Vector3;
  dead: boolean;
  v: { health: number; armor: number; maxHealth: number };
}

export class HealthBarSystem {
  private bars: Map<string, HealthBar> = new Map();
  private ballBars: Map<Targetable, HealthBar> = new Map();
  // Last authoritative health per player - persists beyond bar lifetime so
  // damage predictions accumulate across hits spaced wider than BAR_LIFETIME
  private knownHealth: Map<string, number> = new Map();
  // Last authoritative armor per player - shown as yellow segment on the bar
  private knownArmor: Map<string, number> = new Map();
  // Per-player max from the wire armorClass - a heavy bar drawn against a
  // flat 100 reads full until the target is under half health.
  private knownMax: Map<string, number> = new Map();
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
      .enemy-hpbar.ally .bg {
        background: rgba(60, 200, 90, 0.2);
      }
      .enemy-hpbar.ally .health {
        background: rgba(60, 200, 90, 0.9);
      }
      .enemy-hpbar .white {
        position: absolute; top: 0; left: 0; height: 100%;
        background: rgba(255, 255, 255, 1.0);
        border-radius: 1px;
        display: none;
      }
      .enemy-hpbar .armor {
        position: absolute; top: 100%; left: 0; height: 2px;
        background: rgba(90, 200, 255, 0.95);
        border-radius: 1px;
        display: none;
      }
      .enemy-hpbar .armor.player-armor {
        top: 0; height: 100%;
        background: rgba(255, 200, 50, 0.9);
        border-radius: 1px;
        display: none;
      }
    `;
    document.head.append(style);

    this.container = document.createElement('div');
    this.container.id = 'healthbar-container';
    document.body.append(this.container);
  }

  spawn(playerId: string, damage: number, health: number, armor?: number): void {
    this.upsertBar(playerId, damage, health, armor);
  }

  // Repair-weld bars — keyed by the item itself; health/armor read LIVE
  // off item.v every frame so the bar visibly climbs with the beam,
  // not just on the tick that spawned it. A short linger absorbs the
  // 100ms fire interval; release the trigger and it fades out.
  private repairBars = new Map<RepairTarget, { bar: HealthBar; armorEl: HTMLDivElement }>();

  /** Beam is touching this item right now — show/refresh its vitals. */
  showRepair(item: RepairTarget): void {
    this.showVitals(item, true, REPAIR_LINGER); // welded things are friendly by definition
  }

  /** Took damage — same live-vitals bar, ally color only for our team's
   *  gear; lingers like a hit popup, not the weld tick. */
  showDamage(item: RepairTarget, ally: boolean): void {
    this.showVitals(item, ally, BAR_LIFETIME);
  }

  private showVitals(item: RepairTarget, ally: boolean, linger: number): void {
    let r = this.repairBars.get(item);
    if (!r) {
      const el = this.createBarEl();
      el.classList.toggle('ally', ally);
      const armorEl = document.createElement('div');
      armorEl.className = 'armor';
      el.append(armorEl);
      r = {
        bar: {
          damage: 0, flashTimer: 0, delayTimer: 0, life: 0,
          maxHealth: item.v.maxHealth, currentHealth: item.v.health,
          currentArmor: item.v.armor ?? 0,
          el, bgEl: el.querySelector('.bg')!, healthEl: el.querySelector('.health')!,
          armorEl,
          whiteEl: el.querySelector('.white')!,
        },
        armorEl,
      };
      this.repairBars.set(item, r);
    }
    const rr = this.repairBars.get(item)!;
    rr.bar.life = linger;
  }

  private removeRepair(item: RepairTarget): void {
    const r = this.repairBars.get(item);
    if (r) { r.bar.el.remove(); this.repairBars.delete(item); }
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
    const base = bar ? bar.currentHealth : (this.knownHealth.get(playerId) ?? this.knownMax.get(playerId) ?? MAX_HEALTH);
    const health = Math.max(0, base - damage);
    this.upsertBar(playerId, damage, health);
  }

  private upsertBar(playerId: string, damage: number, health: number, armor?: number): void {
    this.knownHealth.set(playerId, health);
    if (armor !== undefined) {this.knownArmor.set(playerId, armor);}
    const bar = this.bars.get(playerId);
    if (bar) {
      this.resetBar(bar, damage, health, armor);
      return;
    }
    this.bars.set(playerId, this.createHealthBar(damage, health, this.knownMax.get(playerId) ?? MAX_HEALTH, playerId, undefined, armor));
  }

  update(dt: number, players: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean; health?: number; armor?: number; team?: string }>, remotePlayers?: Map<string, { position: THREE.Vector3; isDead: boolean }>, _balls?: Ball[], localTeam?: string): void {
    // Sync authoritative health + armor from the server-fed player map
    for (const [playerId, state] of players) {
      if (state.health !== undefined) {
        const prev = this.knownHealth.get(playerId) ?? 0;
        this.knownHealth.set(playerId, state.health);
        // Reset armor on respawn (health jumped back to max)
        if (state.health > prev + 20) {this.knownArmor.set(playerId, 0);}
      }
      if (state.armor !== undefined) {this.knownArmor.set(playerId, state.armor);}
    }

    const cameraPos = _cameraPos;
    this.camera.getWorldPosition(cameraPos);
    const cameraDir = _cameraDir;
    this.camera.getWorldDirection(cameraDir);

    this.updatePlayerBars(dt, players, remotePlayers, cameraPos, cameraDir, localTeam);

    // Update ball healthbars
    for (const [ball, bar] of this.ballBars) {
      if (ball.dead) {
        this.removeBallBar(ball);
        continue;
      }
      this.updateBallBar(ball, bar, dt, cameraPos, cameraDir);
    }

    this.updateRepairBars(dt, cameraPos, cameraDir);
  }

  private updateRepairBars(dt: number, cameraPos: THREE.Vector3, cameraDir: THREE.Vector3): void {
    // Repair bars — vitals mirror the live item record so the weld
    // visibly knits the bar shut (and the armor sliver grows past full).
    for (const [item, r] of this.repairBars) {
      if (item.dead) { this.removeRepair(item); continue; }
      r.bar.currentHealth = item.v.health;
      r.bar.maxHealth = item.v.maxHealth;
      this.updateBar(r.bar, dt,
        _targetPos.set(item.pos.x, item.pos.y + 1.6, item.pos.z),
        cameraPos, cameraDir, (): void => this.removeRepair(item));
      const cap = item.v.maxHealth * REPAIR_ARMOR_MULT;
      r.armorEl.style.display = item.v.armor > 0.5 ? 'block' : 'none';
      r.armorEl.style.width = `${BAR_WIDTH * Math.min(1, item.v.armor / cap)}px`;
    }
  }

  private updatePlayerBars(dt: number, players: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean; health?: number; armor?: number; team?: string }>, remotePlayers: Map<string, { position: THREE.Vector3; isDead: boolean }> | undefined, cameraPos: THREE.Vector3, cameraDir: THREE.Vector3, localTeam?: string): void {
    const view = { dt, cameraPos, cameraDir, localTeam };
    for (const [playerId, bar] of this.bars) {
      this.syncPlayerBar(playerId, bar, players, remotePlayers, view);
    }
  }

  private syncPlayerBar(playerId: string, bar: HealthBar, players: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean; health?: number; armor?: number; team?: string }>, remotePlayers: Map<string, { position: THREE.Vector3; isDead: boolean }> | undefined, view: { dt: number; cameraPos: THREE.Vector3; cameraDir: THREE.Vector3; localTeam?: string }): void {
    const { dt, cameraPos, cameraDir, localTeam } = view;
    const playerState = players.get(playerId);
    const rp = remotePlayers?.get(playerId);
    // Local bots ('bot:', 'BOT-') have a rendered body but no wire-roster
    // entry — a live rp is sufficient authority for the bar.
    if ((!playerState && !rp) || rp?.isDead || playerState?.isDead) {
      this.removeBar(playerId);
      return;
    }

    this.tagAlly(bar, playerState?.team ?? (rp as { team?: string } | undefined)?.team, localTeam);

    const pos = rp ? rp.position : playerState!.position;
    // Wire class decides the pool — class bonuses stay invisible until
    // the roster carries it, which still beats a flat 100 for heavies.
    bar.maxHealth = this.maxFor(playerId, (rp as { armorClass?: string } | undefined)?.armorClass);
    this.syncVitals(playerId, bar);
    // pos is EYE height - a small margin above it is already over the head.
    // renderLift rides along: the slope lift raises the mesh, not the
    // logical position, so anchoring raw eye sinks the bar mid-body.
    // Stack ABOVE the +1.0 indicator marker — the wounded-popup bar at
    // +0.5 collapsed onto the class silhouette at distance. Repair
    // bars use +1.6 for the same reason; +1.8 clears the marker row.
    const targetPos = _targetPos.set(pos.x, pos.y + ((rp as { renderLift?: number } | undefined)?.renderLift ?? 0) + 1.8, pos.z);
    this.updateBar(bar, dt, targetPos, cameraPos, cameraDir, (): void => this.removeBar(playerId));
  }

  // Sync health + armor from authoritative state.
  private syncVitals(playerId: string, bar: HealthBar): void {
    const kh = this.knownHealth.get(playerId);
    if (kh !== undefined) {bar.currentHealth = kh;}
    const ka = this.knownArmor.get(playerId);
    if (ka !== undefined) {bar.currentArmor = ka;}
  }

  private updateBallBar(ball: Targetable, bar: HealthBar, dt: number, cameraPos: THREE.Vector3, cameraDir: THREE.Vector3): void {
    const targetPos = _targetPos.set(
      ball.pos.x,
      ball.pos.y + ball.radius + 0.5,
      ball.pos.z
    );
    this.updateBar(bar, dt, targetPos, cameraPos, cameraDir, (): void => this.removeBallBar(ball));
  }

  /** Class-aware pool — heavy reads against 200, not 100. */
  private maxFor(playerId: string, cls: string | undefined): number {
    const max = MAX_HEALTH + (CLASS_STATS[cls as keyof typeof CLASS_STATS]?.maxHealth ?? 0);
    this.knownMax.set(playerId, max);
    return max;
  }

  /** Friend-or-foe bar color — wire team wins; offline GameBots carry the
   *  field on their rp record. No team info = red, same as the gizmo tint
   *  rule (teamless modes never turn friendly). Class writes only on flip
   *  so classList churn doesn't run every frame per bar. */
  private tagAlly(bar: HealthBar, theirTeam: string | undefined, localTeam: string | undefined): void {
    const ally = Boolean(localTeam) && theirTeam === localTeam;
    if (ally !== bar.el.classList.contains('ally')) {bar.el.classList.toggle('ally', ally);}
  }

  removeBar(playerId: string): void {
    const bar = this.bars.get(playerId);
    if (bar) {
      bar.el.remove();
      this.bars.delete(playerId);
    }
  }

  /** Player left the roster — drop the bar AND the remembered vitals.
   *  Kept separate from removeBar, which also runs on fade expiry:
   *  knownMax must survive a faded bar or a heavy's next hit re-maxes
   *  at the light default. */
  forgetPlayer(playerId: string): void {
    this.removeBar(playerId);
    this.knownHealth.delete(playerId);
    this.knownMax.delete(playerId);
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
    for (const [, r] of this.repairBars) {r.bar.el.remove();}
    this.repairBars.clear();
    this.knownHealth.clear();
    this.knownMax.clear();
  }

  private createBarEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'enemy-hpbar';
    el.innerHTML = '<div class="bg"></div><div class="health"></div><div class="white"></div>';
    this.container.append(el);
    return el;
  }

  private createHealthBar(
    damage: number,
    health: number,
    maxHealth: number,
    playerId?: string,
    ball?: Targetable,
    armor?: number
  ): HealthBar {
    const el = this.createBarEl();
    // Add armor element (yellow segment) if not already present
    let armorEl = el.querySelector('.armor') as HTMLDivElement | null;
    if (!armorEl) {
      armorEl = document.createElement('div');
      armorEl.className = 'armor player-armor';
      el.append(armorEl);
    }
    return {
      playerId,
      ball,
      damage,
      flashTimer: FLASH_DURATION,
      delayTimer: DELAY_DURATION,
      life: BAR_LIFETIME,
      maxHealth,
      currentHealth: health,
      currentArmor: armor ?? 0,
      el,
      bgEl: el.querySelector('.bg')!,
      healthEl: el.querySelector('.health')!,
      armorEl,
      whiteEl: el.querySelector('.white')!,
    };
  }

  private resetBar(bar: HealthBar, damage: number, health: number, armor?: number): void {
    if (bar.delayTimer > 0) {
      bar.damage += damage;
    } else {
      bar.damage = damage;
    }
    bar.flashTimer = FLASH_DURATION;
    bar.delayTimer = DELAY_DURATION;
    bar.life = BAR_LIFETIME;
    bar.currentHealth = health;
    if (armor !== undefined) {bar.currentArmor = armor;}
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

    this.paintBar(bar);

    const toTarget = _toTarget.subVectors(targetPos, cameraPos);
    const behind = toTarget.angleTo(cameraDir) > Math.PI / 2;

    const projected = _projected.copy(targetPos);
    projected.project(this.camera);

    if (behind) {
      bar.el.style.display = 'none';
      return;
    }

    const scr = { x: 0, y: 0 };
    ndcToClient(projected.x, projected.y, scr);
    const {x} = scr;
    const {y} = scr;

    const onScreen = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
    if (!onScreen) {
      bar.el.style.display = 'none';
      return;
    }

    bar.el.style.display = 'block';
    // transform positioning — compositor-only, no layout work per frame
    bar.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  // Ratio math + element writes — health/armor/damage/white-flash paint.
  private paintBar(bar: HealthBar): void {
    const armor = bar.currentArmor ?? 0;
    const total = bar.currentHealth + armor;
    const totalRatio = Math.max(0, Math.min(1, total / bar.maxHealth));
    const healthRatio = Math.max(0, Math.min(totalRatio, bar.currentHealth / bar.maxHealth));
    const armorRatio = Math.max(0, totalRatio - healthRatio);
    const damageRatio = Math.min(1 - healthRatio, bar.damage / bar.maxHealth);

    bar.healthEl.style.width = `${BAR_WIDTH * healthRatio}px`;
    if (bar.armorEl?.classList.contains('player-armor')) {
      // In-bar segment: gold tail starting where health ends. Repair-bar
      // slivers (class 'armor', under-bar cyan) own their geometry in the
      // repair loop — writing left=healthRatio here AND width=armor/cap
      // there made the sliver overshoot the bar's right edge.
      bar.armorEl.style.display = armor > 0.5 ? 'block' : 'none';
      bar.armorEl.style.left = `${BAR_WIDTH * healthRatio}px`;
      bar.armorEl.style.width = `${BAR_WIDTH * armorRatio}px`;
      bar.armorEl.style.background = 'rgba(255, 200, 50, 0.9)';
    }

    if ((bar.flashTimer > 0 || bar.delayTimer > 0) && damageRatio > 0) {
      // oxlint-disable-next-line init-declarations -- assigned later
      let whiteWidth!: number;
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
  }
}
