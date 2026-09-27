import * as THREE from 'three';
import { Ball, type Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import { settings } from '../core/settings.js';

/**
 * Radar minimap — rotating, player-centered. Up on the map is where the
 * player faces (movement-shooter legibility: answer "where do I need to
 * look?" without spinning the camera).
 *
 * One canvas, no DOM churn: every frame clears + stamps dots. Off-map
 * enemies clamp to the rim so distant threats still read as a direction.
 */
const SIZE = 160;          // css px, square
const RANGE = 150;         // world meters shown at the rim
const RIM = SIZE / 2 - 6;  // dot-clamp radius in px

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cross: boolean;

  constructor(parent: HTMLElement) {
    // ?minimap=cross|corner — persists to the fps-minimap setting
    const qp = new URLSearchParams(location.search).get('minimap');
    if (qp === 'cross' || qp === 'crosshair') settings.set('fps-minimap', 1);
    else if (qp === 'corner') settings.set('fps-minimap', 0);
    this.cross = settings.get('fps-minimap') === 1;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.applyMode();
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    // Settings-panel toggle — applies live, no reload
    const btn = document.getElementById('minimap-toggle');
    if (btn) {
      const label = () => { btn.textContent = this.cross ? 'MINIMAP: CROSSHAIR' : 'MINIMAP: CORNER'; };
      label();
      btn.addEventListener('click', () => {
        this.cross = !this.cross;
        settings.set('fps-minimap', this.cross ? 1 : 0);
        this.applyMode();
        label();
      });
    }
  }

  private applyMode(): void {
    // Crosshair mode: bare dots around the reticle, no dish, no hazards —
    // reading it must cost zero eye movement.
    this.canvas.style.cssText = this.cross
      ? `position: absolute; top: 50%; left: 50%; width: ${SIZE}px; height: ${SIZE}px;
         transform: translate(-50%, -50%); pointer-events: none;`
      : `position: absolute; top: 86px; right: 20px; width: ${SIZE}px; height: ${SIZE}px;
         border-radius: 50%; border: 1px solid rgba(255,255,255,0.25);
         background: rgba(8,12,18,0.55); pointer-events: none;`;
  }

  update(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number): void {
    const c = this.ctx;
    const mid = SIZE / 2;
    c.clearRect(0, 0, SIZE, SIZE);

    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const k = RIM / RANGE;

    // Crosshair mode is threats-only — pickups and hazards aren't threats.
    if (!this.cross) {
      // Nuggets under enemies — pickups shouldn't hide threats
      for (const n of nuggets) {
        const [sx, sy] = this.toMap(n.pos.x - pos.x, n.pos.z - pos.z, sin, cos, k, mid);
        c.fillStyle = 'rgba(255,213,74,0.9)';
        c.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
    for (const e of targets) {
      if (e.dead) continue;
      if (this.cross && e instanceof Ball) continue;
      const [sx, sy] = this.toMap(e.pos.x - pos.x, e.pos.z - pos.z, sin, cos, k, mid);
      // Balls don't attack — cyan hazard, not red threat
      c.fillStyle = e instanceof Ball ? 'rgba(80,200,255,0.9)' : 'rgba(255,70,60,0.95)';
      c.beginPath();
      c.arc(sx, sy, 2.5, 0, Math.PI * 2);
      c.fill();
    }

    // Center wedge = the player facing up (crosshair mode: the reticle
    // already occupies the center)
    if (!this.cross) {
      c.fillStyle = '#e8f4ff';
      c.beginPath();
      c.moveTo(mid, mid - 6);
      c.lineTo(mid - 4, mid + 4);
      c.lineTo(mid + 4, mid + 4);
      c.closePath();
      c.fill();
    }
  }

  private toMap(dx: number, dz: number, sin: number, cos: number, k: number, mid: number): [number, number] {
    // right = (-cos, sin), forward = (sin, cos) — same basis as Player
    const rx = -dx * cos + dz * sin;
    const ry = dx * sin + dz * cos;
    const px = rx * k, py = -ry * k; // screen y grows down
    const d = Math.hypot(px, py);
    if (d <= RIM) return [mid + px, mid + py];
    const s = RIM / d;
    return [mid + px * s, mid + py * s];
  }
}
