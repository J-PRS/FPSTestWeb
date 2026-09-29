// Player indicators — the red dots marking remote players, including the
// screen-edge clamp when they're off-camera. Owns its per-player div map and
// the projection scratch vectors (runs per-player per-frame, no allocs).
import * as THREE from 'three';
import { ChildLogger } from '../../core/Logger.js';

const logger = new ChildLogger('HUD');

const _cameraPos = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _projected = new THREE.Vector3();

export class PlayerIndicators {
  private readonly container: HTMLElement;
  private readonly indicators = new Map<string, HTMLDivElement>();
  // Cache last written values — position via transform (compositor-only,
  // no layout) and size only when the px value actually changes.
  private readonly lastSize = new Map<string, number>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  update(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, opts: { isDead?: boolean; friendly?: boolean; variant?: string; sheep?: number } = {}): void {
    const { isDead = false, friendly = false, variant, sheep } = opts;
    let indicator = this.indicators.get(playerId);
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'player-indicator';
      this.container.appendChild(indicator);
      this.indicators.set(playerId, indicator);
      logger.debug('INDICATOR CREATED', { playerId, total: this.indicators.size });
    }
    indicator.classList.toggle('friendly', friendly);
    if (variant) for (const c of variant.split(' ')) indicator.classList.add(c);
    this.updateSheepBadge(indicator, sheep);

    if (isDead) {
      indicator.classList.add('hidden');
      return;
    }
    indicator.classList.remove('hidden');

    camera.getWorldPosition(_cameraPos);
    camera.getWorldDirection(_cameraDir);

    // Position is at feet — point to center (feet + 1.0)
    const targetPos = _targetPos.set(position.x, position.y + 1.0, position.z);
    const toTarget = _toTarget.subVectors(targetPos, _cameraPos);

    const behind = toTarget.angleTo(_cameraDir) > Math.PI / 2;

    const vector = _projected.copy(targetPos);
    vector.project(camera);

    let x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    let y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;

    if (behind) {
      x = window.innerWidth - x;
      y = window.innerHeight - y;
    }

    const onScreen = !behind && x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;

    if (onScreen) {
      indicator.classList.remove('offscreen');
      // Scale dot by inverse square root of distance (gentler than 1/d)
      const distance = _cameraPos.distanceTo(targetPos);
      const REF_DIST = 50;
      const MIN_SIZE = 6;
      const MAX_SIZE = 12;
      const scale = REF_DIST / Math.sqrt(Math.max(distance, 1));
      const size = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, 12 * scale)));
      if (this.lastSize.get(playerId) !== size) {
        this.lastSize.set(playerId, size);
        indicator.style.width = `${size}px`;
        indicator.style.height = `${size}px`;
      }
      this.setPos(indicator, x, y);
    } else {
      indicator.classList.add('offscreen');

      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const dx = x - centerX;
      const dy = y - centerY;
      const angle = Math.atan2(dy, dx);

      const margin = 40;
      const halfWidth = window.innerWidth / 2 - margin;
      const halfHeight = window.innerHeight / 2 - margin;
      const dist = Math.min(halfWidth / Math.abs(Math.cos(angle)), halfHeight / Math.abs(Math.sin(angle)));

      this.setPos(indicator, centerX + Math.cos(angle) * dist, centerY + Math.sin(angle) * dist);
    }
  }

  /** Sheep badge — the server's bot mobility meter, floated over the
   *  head so a sheepish bot can be eyeballed, not just read in logs. */
  private updateSheepBadge(indicator: HTMLElement, sheep: number | undefined): void {
    let badge = indicator.firstElementChild as HTMLElement | null;
    if (sheep !== undefined && sheep > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sheep-badge';
        indicator.appendChild(badge);
      }
      badge.textContent = `${sheep}`;
      badge.style.color = sheep >= 60 ? '#ff6b6b' : sheep >= 30 ? '#ffd166' : '#7ddf7d';
    } else if (badge) {
      badge.remove();
    }
  }

  // transform keeps the -50% centering from the stylesheet while moving the
  // element on the compositor — layout isn't touched at 60Hz.
  private setPos(el: HTMLElement, x: number, y: number): void {
    el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  remove(playerId: string): void {
    const indicator = this.indicators.get(playerId);
    if (indicator) {
      indicator.remove();
      this.indicators.delete(playerId);
      this.lastSize.delete(playerId);
      logger.debug('INDICATOR REMOVED', { playerId, total: this.indicators.size });
    }
  }

  clear(): void {
    this.indicators.forEach(i => i.remove());
    this.indicators.clear();
    this.lastSize.clear();
  }
}
