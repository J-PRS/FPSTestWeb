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
  private readonly _map: [number, number] = [0, 0];

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

  update(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[]): void {
    const c = this.ctx;
    const mid = SIZE / 2;
    c.clearRect(0, 0, SIZE, SIZE);

    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const k = RIM / RANGE;

    // Crosshair mode is threats-only — pickups and hazards aren't threats.
    const m = this._map; // scratch — toMap fills it instead of allocating
    if (!this.cross) {
      // Nuggets under enemies — pickups shouldn't hide threats
      for (const n of nuggets) {
        this.toMap(n.pos.x - pos.x, n.pos.z - pos.z, sin, cos, k, mid);
        c.fillStyle = 'rgba(255,213,74,0.9)';
        c.fillRect(m[0] - 1, m[1] - 1, 2, 2);
      }
    }
    for (const e of targets) {
      if (e.dead) continue;
      // Scoreless props (tumbleweeds, buzzards) aren't threats — don't ping
      // radar. Buzzards still get their own debug rings below.
      if (e.scoreless) continue;
      // Crosshair mode is threats-only — but an enraged ball IS a threat
      if (this.cross && e instanceof Ball && !e.isEnraged) continue;
      this.toMap(e.pos.x - pos.x, e.pos.z - pos.z, sin, cos, k, mid);
      // Enraged balls are actively hunting you — promote cyan hazard to
      // red threat so an incoming dash pings radar like a real enemy.
      c.fillStyle = e instanceof Ball && !e.isEnraged ? 'rgba(80,200,255,0.9)' : 'rgba(255,70,60,0.95)';
      c.beginPath();
      c.arc(m[0], m[1], 2.5, 0, Math.PI * 2);
      c.fill();
    }

    // Debug: ambient buzzards — white hollow rings, unmistakably not enemies
    if (birds) {
      c.strokeStyle = 'rgba(240,240,255,0.8)';
      c.lineWidth = 1;
      for (const b of birds) {
        this.toMap(b.x - pos.x, b.z - pos.z, sin, cos, k, mid);
        c.beginPath();
        c.arc(m[0], m[1], 2.5, 0, Math.PI * 2);
        c.stroke();
      }
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

  private toMap(dx: number, dz: number, sin: number, cos: number, k: number, mid: number): void {
    // right = (-cos, sin), forward = (sin, cos) — same basis as Player
    const rx = -dx * cos + dz * sin;
    const ry = dx * sin + dz * cos;
    const px = rx * k, py = -ry * k; // screen y grows down
    const d = Math.hypot(px, py);
    const m = this._map;
    if (d <= RIM) { m[0] = mid + px; m[1] = mid + py; return; }
    const s = RIM / d;
    m[0] = mid + px * s; m[1] = mid + py * s;
  }
}
