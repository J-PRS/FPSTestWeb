// Player indicators — the red dots marking remote players, including the
// screen-edge clamp when they're off-camera. Owns its per-player div map and
// the projection scratch vectors (runs per-player per-frame, no allocs).
import * as THREE from 'three';
import { ChildLogger } from '../../core/Logger.js';
import { tokenTier } from '../../../../shared/pickups.js';

const band = (x: number, invert: boolean): string => {
  if (x >= 60) {return invert ? '#ff6b6b' : '#7ddf7d';}
  if (x >= 30) {return '#ffd166';}
  return invert ? '#7ddf7d' : '#ff6b6b';
};


const logger = new ChildLogger('HUD');

const _cameraPos = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _projected = new THREE.Vector3();

/** Backquote debug overlay — sheep meters (the server's bot mobility
 *  stat) only draw under it. The everyday badge over a head is HP. */
let debugOverlays = false;
export function setDebugOverlays(v: boolean): void { debugOverlays = v; }
export function debugOverlaysOn(): boolean { return debugOverlays; }

export class PlayerIndicators {
  private readonly container: HTMLElement;
  private readonly indicators = new Map<string, HTMLDivElement>();
  // Cache last written values — position via transform (compositor-only,
  // no layout) and size only when the px value actually changes.
  private readonly lastSize = new Map<string, number>();
  private readonly lastSheep = new Map<string, string>();
  private readonly lastPos = new Map<string, number>();

  // camera.getWorldPosition/Direction decomposes matrixWorld per call —
  // called once per remote per frame that was ~2 decomposes × N players.
  // The camera matrix changes at most once per render, so compare it and
  // reuse the decompose until it does.
  private readonly lastCamMat = new Float32Array(16);
  private camDirty = true;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  private refreshCamera(camera: THREE.Camera): void {
    const e = camera.matrixWorld.elements;
    if (!this.camDirty) {
      for (let i = 0; i < 16; i += 1) {if (this.lastCamMat[i] !== e[i]) { this.camDirty = true; break; }}
    }
    if (!this.camDirty) {return;}
    this.lastCamMat.set(e);
    this.camDirty = false;
    camera.getWorldPosition(_cameraPos);
    camera.getWorldDirection(_cameraDir);
  }

  update(playerId: string, position: { x: number; y: number; z: number }, camera: THREE.Camera, opts: { isDead?: boolean; friendly?: boolean; variant?: string; sheep?: number; bot?: boolean; cls?: string; hp?: number; held?: number; name?: string } = {}): void {
    const { isDead = false, friendly = false, variant, sheep, bot, cls, hp, held, name } = opts;
    let indicator = this.indicators.get(playerId);
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'player-indicator';
      this.container.append(indicator);
      this.indicators.set(playerId, indicator);
      logger.debug('INDICATOR CREATED', { playerId, total: this.indicators.size });
    }
    indicator.classList.toggle('friendly', friendly);
    // Silhouette = armor class (light chevron / medium V+◆ / heavy ▼);
    // bots render the same shape dimmed — class stays readable on bots.
    indicator.classList.toggle('bot', Boolean(bot));
    const clsKey = cls === 'light' || cls === 'heavy' ? cls : 'medium';
    for (const k of ['light', 'medium', 'heavy']) {indicator.classList.toggle(`cls-${k}`, !variant && clsKey === k);}
    if (variant) {for (const c of variant.split(' ')) {indicator.classList.add(c);}}
    this.updateSheepBadge(playerId, indicator, sheep, hp, friendly, bot ? undefined : name);
    this.updateHeldBadge(playerId, indicator, held, friendly);

    if (isDead) {
      indicator.classList.add('hidden');
      return;
    }
    indicator.classList.remove('hidden');

    this.refreshCamera(camera);

    // Position is at feet — point to center (feet + 1.0)
    const targetPos = _targetPos.set(position.x, position.y + 1, position.z);
    const toTarget = _toTarget.subVectors(targetPos, _cameraPos);

    const behind = toTarget.angleTo(_cameraDir) > Math.PI / 2;

    // Indicators reproject every frame — markers must track the rendered
    // body 1:1. A rate-limited dot slides behind a panning camera, which
    // reads as lag on the ONE element that must feel snappy.
    const distSq = toTarget.lengthSq();

    this.layout(playerId, indicator, targetPos, camera, behind, distSq);
  }

  private layout(playerId: string, indicator: HTMLElement, targetPos: THREE.Vector3, camera: THREE.Camera, behind: boolean, distSq: number): void {
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
      const distance = Math.sqrt(distSq);
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
      this.setPos(playerId, indicator, x, y);
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

      this.setPos(playerId, indicator, centerX + Math.cos(angle) * dist, centerY + Math.sin(angle) * dist);
    }
  }

  /** Head badge — human names win, bots keep the HP number (the cheap
   *  who's-real read); under the backquote debug overlay the server's
   *  sheep meter takes the slot instead (that's where the
   *  pedestrian-vs-skier read lives for triage). */
  private updateSheepBadge(playerId: string, indicator: HTMLElement, sheep: number | undefined, hp: number | undefined, friendly: boolean, name?: string): void {
    const sheepMode = debugOverlays && sheep !== undefined && sheep > 0;
    let text: string | null = null;
    if (sheepMode) {text = `${Math.round(sheep!)}`;}
    else if (name) {text = name.length > 16 ? `${name.slice(0, 15)}…` : name;}
    else if (hp !== undefined) {text = `${Math.round(hp)}`;}
    // Text + team + mode ride the cache key — a rename, debug toggle or
    // team swap must rewrite the badge even when the text is unchanged.
    const key = text === null ? '' : `${text}|${sheepMode ? 's' : ''}|${friendly ? 'f' : 'e'}`;
    if (this.lastSheep.get(playerId) === key) {return;}
    this.lastSheep.set(playerId, key);
    let badge = indicator.firstElementChild as HTMLElement | null;

    if (text !== null) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sheep-badge';
        indicator.append(badge);
      }
      badge.textContent = text;
      // Team-locked color: the health-gradient read as "which side is
      // that?" mid-fight — ally green / enemy red carries no HP info
      // but never lies about allegiance. (sheep debug keeps its band.)
      badge.style.color = sheepMode ? band(sheep!, true) : friendly ? '#7ddf7d' : '#ff6b6b';
    } else if (badge) {
      badge.remove();
    }
  }

  /** Headhunt held-token badge — stacked above the HP badge, team color,
   *  font grows with the hoard (a fat count IS the bounty marker). Only
   *  renders while the wire carries `held` (headhunt rooms). */
  private readonly lastHeld = new Map<string, number>();
  private updateHeldBadge(playerId: string, indicator: HTMLElement, held: number | undefined, _friendly: boolean): void {
    // Count colored by the TOP coin in the pile (tokenTier snaps odd
    // values to their denomination) — the dot/healthbar already carry
    // the friend/foe read; the number should carry the bounty.
    const size = held === undefined ? -1 : Math.min(20, Math.max(11, 11 + Math.floor(held * 0.45)));
    const key = held === undefined ? -1 : held * 64 + size;
    if (this.lastHeld.get(playerId) === key) {return;}
    this.lastHeld.set(playerId, key);
    let badge = indicator.querySelector('.held-badge') as HTMLElement | null;
    if (held === undefined) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'held-badge';
      indicator.append(badge);
    }
    badge.textContent = `${held}`;
    badge.style.color = `#${tokenTier(held).color.toString(16).padStart(6, '0')}`;
    badge.style.fontSize = `${size}px`;
  }

  // transform keeps the -50% centering from the stylesheet while moving the
  // element on the compositor — layout isn't touched at 60Hz. The packed
  // 0.1px-quantized key skips the style write entirely on still frames.
  private setPos(playerId: string, el: HTMLElement, x: number, y: number): void {
    const q = Math.round(x * 10) * 100_000 + Math.round(y * 10);
    if (this.lastPos.get(playerId) === q) {return;}
    this.lastPos.set(playerId, q);
    el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  remove(playerId: string): void {
    const indicator = this.indicators.get(playerId);
    if (indicator) {
      indicator.remove();
      this.indicators.delete(playerId);
      this.lastSize.delete(playerId);
      this.lastSheep.delete(playerId);
      this.lastHeld.delete(playerId);
      this.lastPos.delete(playerId);
      logger.debug('INDICATOR REMOVED', { playerId, total: this.indicators.size });
    }
  }

  clear(): void {
    this.indicators.forEach((i): void => i.remove());
    this.indicators.clear();
    this.lastSize.clear();
    this.lastSheep.clear();
    this.lastHeld.clear();
    this.lastPos.clear();
  }
}
