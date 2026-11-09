import type * as THREE from 'three';
import { Ball, type Targetable } from '../entities/balls.js';
import type { Nugget } from '../entities/Nugget.js';
import { settings } from '../core/settings.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';

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

/** A player/bot blip — resolved to friend-or-foe by the caller, which owns
 *  team state. Coords are world xz. */
export interface MinimapPlayer { x: number; z: number; friendly: boolean; bot?: boolean }

/** A conquest lattice cell — owner color; `hot` marks the contested
 *  frontier (owned AND enemy-actionable) for either team's focus. */
export interface MinimapNode { pos: { x: number; z: number }; owner: 'alpha' | 'bravo' | 'neutral'; core: boolean; hot: boolean }

// Per-frame transform basis the draw layers share — computed once in update.
interface MapBasis { pos: THREE.Vector3; sin: number; cos: number; k: number; mid: number }

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cross: boolean;
  private readonly _map: [number, number] = [0, 0];

  constructor(private parent: HTMLElement) {
    this.cross = settings.get('fps-minimap') === 1;

    this.canvas = document.createElement('canvas');
    // Backing store at device pixels — CSS size stays SIZE, draw space
    // stays [0,SIZE] via the ctx scale; without this hidpi upscales soft.
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.height = SIZE * dpr;
    this.canvas.width = this.canvas.height;
    this.applyMode(); // owns canvas placement (TR region vs HUD anchor)
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    // Settings-panel toggle — applies live, no reload
    const btn = document.querySelector('#minimap-toggle');
    if (btn) {
      const label = (): void => { btn.textContent = this.cross ? 'MINIMAP: CROSSHAIR' : 'MINIMAP: CORNER'; };
      label();
      btn.addEventListener('click', (): void => {
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
    // Dish mode rides the TR region stack; crosshair mode must anchor to
    // the HUD box itself (region-relative 50% would center on the stack).
    const host = this.cross ? this.parent : (document.getElementById('hud-reg-tr') ?? this.parent);
    if (this.canvas.parentElement !== host) {host.append(this.canvas);}
    this.canvas.style.cssText = this.cross
      ? `position: absolute; top: 50%; left: 50%; width: ${SIZE}px; height: ${SIZE}px;
         transform: translate(-50%, -50%); pointer-events: none;`
      : `width: ${SIZE}px; height: ${SIZE}px;
         border-radius: 50%; border: 1px solid rgba(255,255,255,0.25);
         background: rgba(8,12,18,0.55); pointer-events: none;`;
  }

  update(targets: Targetable[], nuggets: Nugget[], pos: THREE.Vector3, yaw: number, birds?: THREE.Vector3[], players?: Iterable<MinimapPlayer>, nodes?: Iterable<MinimapNode>): void {
    const c = this.ctx;
    const mid = SIZE / 2;
    c.clearRect(0, 0, SIZE, SIZE);

    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const k = RIM / RANGE;
    const t = { pos, sin, cos, k, mid };

    // Crosshair mode is threats-only — pickups and hazards aren't threats.
    if (!this.cross) {this.drawNuggets(nuggets, t);}
    this.drawNodes(nodes, t);
    this.drawTargets(targets, t);
    this.drawPlayers(players, t);
    this.drawBirds(birds, t);

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

  // Conquest nodes under everything — territory is context, not threat.
  // Cell = owner color square; contested frontier cells get a white
  // threat ring so "the fight is HERE" reads even without team memory.
  // Cores get a bold double-weight box = the win condition.
  private drawNodes(nodes: Iterable<MinimapNode> | undefined, t: MapBasis): void {
    if (!nodes) {return;}
    const c = this.ctx, m = this._map;
    // Lattice links first (under the cells): 4-neighbors on the grid.
    // Cell pitch = min nonzero pair distance; same-owner gets a solid
    // team line, mixed pairs get a middle-half gradient blend.
    const pts: { x: number; y: number; col: string; owner: string; core: boolean; hot: boolean }[] = [];
    for (const n of nodes) {
      this.toMap(n.pos.x - t.pos.x, n.pos.z - t.pos.z, t.sin, t.cos, t.k, t.mid);
      const col = n.owner === 'neutral' ? 'rgba(140,148,158,0.8)' : `#${(TEAM_COLORS[n.owner as TeamId] ?? 0xFF_FF_FF).toString(16).padStart(6, '0')}`;
      pts.push({ x: m[0], y: m[1], col, owner: n.owner, core: n.core, hot: n.hot });
    }
    let pitch = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d > 0.5 && d < pitch) {pitch = d;}
      }
    }
    if (pitch < Infinity) {
      const near = pitch * 1.15;
      c.lineWidth = 1.5;
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          const a = pts[i]!, b = pts[j]!;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > near) {continue;}
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
          if (a.owner === b.owner) {c.strokeStyle = a.col; c.globalAlpha = 0.55; c.stroke(); continue;}
          const g = c.createLinearGradient(
            a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25,
            a.x + (b.x - a.x) * 0.75, a.y + (b.y - a.y) * 0.75);
          g.addColorStop(0, a.col); g.addColorStop(1, b.col);
          c.strokeStyle = g; c.globalAlpha = 0.55; c.stroke();
        }
      }
      c.globalAlpha = 1;
    }
    for (const p of pts) {
      c.fillStyle = p.col;
      const s = p.core ? 3.4 : 2.4;
      c.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      if (p.hot) {
        c.strokeStyle = 'rgba(255,255,255,0.95)';
        c.lineWidth = 1;
        c.beginPath();
        c.arc(p.x, p.y, s + 2, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  // Nuggets under enemies — pickups shouldn't hide threats.
  private drawNuggets(nuggets: Nugget[], t: MapBasis): void {
    const c = this.ctx, m = this._map;
    for (const n of nuggets) {
      this.toMap(n.pos.x - t.pos.x, n.pos.z - t.pos.z, t.sin, t.cos, t.k, t.mid);
      c.fillStyle = 'rgba(255,213,74,0.9)';
      c.fillRect(m[0] - 1, m[1] - 1, 2, 2);
    }
  }

  private drawTargets(targets: Targetable[], t: MapBasis): void {
    const c = this.ctx, m = this._map;
    for (const e of targets) {
      if (e.dead) {continue;}
      // Scoreless props (tumbleweeds, buzzards) aren't threats — don't ping
      // radar. Buzzards still get their own debug rings below.
      if (e.scoreless) {continue;}
      // Crosshair mode is threats-only — but an enraged ball IS a threat
      if (this.cross && e instanceof Ball && !e.isEnraged) {continue;}
      this.toMap(e.pos.x - t.pos.x, e.pos.z - t.pos.z, t.sin, t.cos, t.k, t.mid);
      // Enraged balls are actively hunting you — promote cyan hazard to
      // red threat so an incoming dash pings radar like a real enemy.
      c.fillStyle = e instanceof Ball && !e.isEnraged ? 'rgba(80,200,255,0.9)' : 'rgba(255,70,60,0.95)';
      c.beginPath();
      c.arc(m[0], m[1], 2.5, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Players and bots ride ON TOP of creature dots — a red threat dot the
  // same size as a ball's reads as "creature", not "enemy". Marker colors
  // match the overhead .player-indicator: enemy red / friendly green,
  // white rim. 1.8px vs creatures' 2.5 so a stacked pair still separates.
  // Humans draw as diamonds, bots as round dots — same split as the
  // overhead markers, so "who's real" reads on radar too.
  private drawPlayers(players: Iterable<MinimapPlayer> | undefined, t: MapBasis): void {
    if (!players) {return;}
    const c = this.ctx, m = this._map;
    c.lineWidth = 1;
    for (const p of players) {
      this.toMap(p.x - t.pos.x, p.z - t.pos.z, t.sin, t.cos, t.k, t.mid);
      c.fillStyle = p.friendly ? 'rgba(68,221,68,0.95)' : 'rgba(255,68,68,0.95)';
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.beginPath();
      if (p.bot) {
        c.arc(m[0], m[1], 1.8, 0, Math.PI * 2);
      } else {
        // Diamond ≈ the circle's bounding square — same visual weight.
        const r = 2.5;
        c.moveTo(m[0], m[1] - r);
        c.lineTo(m[0] + r, m[1]);
        c.lineTo(m[0], m[1] + r);
        c.lineTo(m[0] - r, m[1]);
        c.closePath();
      }
      c.fill();
      c.stroke();
    }
  }

  // Debug: ambient buzzards — white hollow rings, unmistakably not enemies
  private drawBirds(birds: THREE.Vector3[] | undefined, t: MapBasis): void {
    if (!birds) {return;}
    const c = this.ctx, m = this._map;
    c.strokeStyle = 'rgba(240,240,255,0.8)';
    c.lineWidth = 1;
    for (const b of birds) {
      this.toMap(b.x - t.pos.x, b.z - t.pos.z, t.sin, t.cos, t.k, t.mid);
      c.beginPath();
      c.arc(m[0], m[1], 2.5, 0, Math.PI * 2);
      c.stroke();
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
