import type * as THREE from 'three';

import { getHeightmapData, getWorldScale, sampleHeight } from '../world/heightmap.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import type { MinimapPlayer } from './minimap.js';

/**
 * Command map — the T2-style full-field popup: the whole heightfield
 * hillshaded north-up with objectives and blips in world space. Distinct
 * from the radar Minimap (rotating, 150m threat range, zero eye travel) —
 * this is the "where is everything / where am I going" view.
 *
 * The terrain bake renders once per heightfield (the heightmap buffer
 * reference doubles as the map-swap key — reloadHeightmap swaps it).
 */

const RES = 512;            // bake pixels — sampled straight off the field
const DRAW = 560;           // css px square (CSS scales down on small screens)
// Sun from NW, ~50° elevation — the classic map hillshade convention.
const SUN_X = -0.55, SUN_Z = -0.55, SUN_Y = 0.85;

interface FlagBlip {
  home: THREE.Vector3;
  homeKnown: boolean;
  carrier: string | null;
  wirePos: THREE.Vector3;
}

export class CommandMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bake: HTMLCanvasElement | null = null;
  private bakedFor: Uint8ClampedArray | null = null;
  private open = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.height = RES;
    this.canvas.width = this.canvas.height;
    this.canvas.style.cssText = `position: absolute; top: 50%; left: 50%;
      width: min(${DRAW}px, 82vmin); height: min(${DRAW}px, 82vmin);
      transform: translate(-50%, -50%); pointer-events: none; display: none;
      border: 1px solid rgba(255,255,255,0.3); border-radius: 6px;
      background: rgba(6,10,14,0.92);`;
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  get isOpen(): boolean { return this.open; }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.canvas.style.display = this.open ? 'block' : 'none';
    // Same stacking problem the scoreboard solves with .sb-open: world-
    // anchored markers are later #hud siblings and paint over the map.
    this.canvas.parentElement?.classList.toggle('cm-open', this.open);
  }

  /** Per-frame while open: blit the baked terrain, then stamp objectives
   *  + players + the self arrow in world space. */
  update(pos: THREE.Vector3, yaw: number, players: Iterable<MinimapPlayer>,
         flags: Map<TeamId, FlagBlip> | undefined): void {
    if (!this.open) {return;}
    const W = getWorldScale();
    this.ensureBake();
    const c = this.ctx;
    if (this.bake) {c.drawImage(this.bake, 0, 0);} else { c.fillStyle = '#0a0e12'; c.fillRect(0, 0, RES, RES); }
    // The heightfield wraps — a player at wx > W/2 is standing on valid
    // repeating terrain. Fold coords into the tile or blips (incl. the
    // self arrow) draw off-canvas and vanish.
    const wrap = (w: number): number => (((w / W + 0.5) % 1) + 1) % 1 * RES;
    const mx = wrap, my = wrap;

    // Flag diamonds ride wirePos (carried flags track the runner); a
    // hollow ring marks the stand's home so a pulled flag still shows
    // where it must return.
    if (flags) {
      c.lineWidth = 1.5;
      for (const [team, f] of flags) {
        const col = `#${  (TEAM_COLORS[team] ?? 0xFF_FF_FF).toString(16).padStart(6, '0')}`;
        c.strokeStyle = col;
        if (f.homeKnown) {
          c.beginPath();
          c.arc(mx(f.home.x), my(f.home.z), 5.5, 0, Math.PI * 2);
          c.stroke();
        }
        c.fillStyle = col;
        c.beginPath();
        const fx = mx(f.wirePos.x), fy = my(f.wirePos.z);
        c.moveTo(fx, fy - 5); c.lineTo(fx + 5, fy); c.lineTo(fx, fy + 5); c.lineTo(fx - 5, fy);
        c.closePath(); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.85)'; c.stroke();
      }
    }

    for (const p of players ?? []) {
      c.fillStyle = p.friendly ? 'rgba(68,221,68,0.95)' : 'rgba(255,68,68,0.95)';
      c.beginPath();
      c.arc(mx(p.x), my(p.z), p.bot ? 2.2 : 3, 0, Math.PI * 2);
      c.fill();
    }

    // Self: white heading wedge — facing read on a north-up map
    const px = mx(pos.x), py = my(pos.z);
    c.save();
    c.translate(px, py);
    c.rotate(-yaw); // y-down canvas: forward (sin,cos) xz → (sin,+cos) screen
    c.fillStyle = '#e8f4ff';
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.beginPath();
    c.moveTo(0, 7); c.lineTo(-5, -4); c.lineTo(5, -4);
    c.closePath(); c.fill(); c.stroke();
    c.restore();
  }

  /** Hillshade bake: height ramp + NW sun slope lighting. sampleHeight is
   *  bilinear off the same RGBA field the GPU displaces — the map is the
   *  sim's ground truth, no second decode. */
  private ensureBake(): void {
    const hm = getHeightmapData();
    if (!hm) { this.bake = null; return; }
    if (this.bakedFor === hm.data && this.bake) {return;}
    this.bakedFor = hm.data;
    const W = getWorldScale();
    const step = W / RES;
    const img = this.ctx.createImageData(RES, RES);
    let hMin = Infinity, hMax = -Infinity;
    const hAt = (px: number, py: number) => sampleHeight((px / RES - 0.5) * W, (py / RES - 0.5) * W);
    for (let py = 0; py < RES; py++) {
      for (let px = 0; px < RES; px++) {
        const h = hAt(px, py);
        if (h < hMin) {hMin = h;}
        if (h > hMax) {hMax = h;}
      }
    }
    const range = Math.max(1, hMax - hMin);
    for (let py = 0; py < RES; py++) {
      for (let px = 0; px < RES; px++) {
        const h = hAt(px, py);
        // Central differences → surface normal → sun lambert.
        const gx = (hAt(px + 1, py) - hAt(px - 1, py)) / (2 * step);
        const gz = (hAt(px, py + 1) - hAt(px, py - 1)) / (2 * step);
        const inv = 1 / Math.hypot(gx, 1, gz);
        const nx = -gx * inv, ny = inv, nz = -gz * inv;
        const shade = Math.max(0, nx * SUN_X + ny * SUN_Y + nz * SUN_Z);
        const t = (h - hMin) / range;
        // Deep-teal lowlands → pale ridgeline; hillshade modulates.
        const lum = 0.25 + 0.75 * shade;
        const o = (py * RES + px) * 4;
        img.data[o] = (18 + 55 * t) * lum;
        img.data[o + 1] = (32 + 70 * t) * lum;
        img.data[o + 2] = (40 + 85 * t) * lum;
        img.data[o + 3] = 235;
      }
    }
    const b = document.createElement('canvas');
    b.height = RES;
    b.width = b.height;
    b.getContext('2d')!.putImageData(img, 0, 0);
    this.bake = b;
  }
}
