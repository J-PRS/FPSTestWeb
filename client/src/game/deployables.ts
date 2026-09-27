// Deployables — the base-economy layer. Player presses `deploy` to plant
// the selected pack item ahead of them; `cycleDeploy` picks the item.
//
// Two items in the first tranche:
//   turret — friendly sentry, hitscan-snaps creatures + enemy bots
//   mine   — proximity charge that triggers on ENEMIES (not the planter)
//
// Deployables are creature-visible: they appear in the species targeting
// candidates (dep:N ids) so the wildlife chews on them — that's the T2
// "defense gets razed" pressure. They are NOT in entities.targets, so the
// owner's own explosives don't grief the base they built.

import * as THREE from 'three';
import { DeployTurret } from '../entities/DeployTurret.js';
import { Mine } from '../entities/Mine.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { MINE_DAMAGE_MAX, ROCKET_RADIUS } from '../core/config.js';
import type { GameContext } from './context.js';
import type { Targetable } from '../entities/balls.js';
import type { TargetCandidate } from './targeting.js';

export type DeployKind = 'turret' | 'mine';

export const DEPLOY_DEFS: { kind: DeployKind; label: string; max: number }[] = [
  { kind: 'turret', label: 'SENTRY', max: 2 },
  { kind: 'mine',   label: 'MINE',   max: 6 },
];

const TURRET_DMG = 9;
const DEPLOY_AHEAD = 4;   // meters in front of the player
const DEPLOY_SLOPE = 0.75; // normal.y floor — can't plant on cliffs

interface Item {
  kind: DeployKind;
  candId: string;
  pos: THREE.Vector3;
  dead: boolean;
  update: (dt: number) => void;
  dispose: () => void;
  hurt: (dmg: number) => void;
}

export interface DeployDeps extends GameContext {
  scene: THREE.Scene;    // scene exists before deployables is constructed
  targets: Targetable[]; // shared creature surface
  lazyCombat: () => { hitTargetLocal(t: Targetable, dmg: number): boolean } | undefined;
  /** Enemy bots the turret may legally shoot (deployer's team excluded). */
  enemyBots?: () => { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
  /** Damage funnel for bot hits — same authority as a player's bolts. */
  damageBot?: (playerId: string, dmg: number, fromPos: THREE.Vector3) => boolean;
  /** Feed/HUD hint for selection + placement results. */
  notify?: (text: string) => void;
}

export class Deployables {
  private items: Item[] = [];
  private sel = 0;
  private tracers: { line: THREE.Line; t: number }[] = [];
  private readonly _zeroVel = new THREE.Vector3();
  private readonly _candList: TargetCandidate[] = [];
  private readonly _enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] = [];

  constructor(private deps: DeployDeps) {}

  /** Current selection label for HUD/feed display. */
  get selectionLabel(): string { return DEPLOY_DEFS[this.sel]!.label; }

  cycle(): void {
    this.sel = (this.sel + 1) % DEPLOY_DEFS.length;
    this.deps.notify?.(`PACK: ${this.selectionLabel}`);
  }

  /** Plant the selected item ~4m ahead on the terrain. */
  deploy(): void {
    const p = this.deps.lazyPlayer();
    const terrain = this.deps.lazyTerrain();
    const def = DEPLOY_DEFS[this.sel]!;
    // Forward = (sin(yaw), cos(yaw)) — same convention debugHooks/dummy use.
    const pos = new THREE.Vector3(
      p.pos.x + Math.sin(p.yaw) * DEPLOY_AHEAD,
      0,
      p.pos.z + Math.cos(p.yaw) * DEPLOY_AHEAD,
    );
    if (terrain.getNormal(pos.x, pos.z).y < DEPLOY_SLOPE) {
      this.deps.notify?.('NO PLACEMENT — TERRAIN TOO STEEP');
      return;
    }
    const live = this.items.filter(i => i.kind === def.kind && !i.dead);
    if (live.length >= def.max) {
      // T2 rule: a new plant retires your oldest of that kind
      const oldest = live[0]!;
      oldest.dead = true;
    }
    if (def.kind === 'turret') this.plantTurret(pos);
    else this.plantMine(pos);
    this.deps.notify?.(`${def.label} DEPLOYED`);
  }

  private plantTurret(pos: THREE.Vector3): void {
    const t = new DeployTurret(this.deps.scene, this.deps.lazyTerrain(), pos);
    const item: Item = {
      kind: 'turret', candId: t.candId, pos: t.pos, dead: false,
      hurt: (dmg) => t.takeDamage(dmg),
      update: (dt) => {
        this._enemies.length = 0;
        for (const c of this.deps.targets) {
          if (c.dead || c.scoreless) continue;
          this._enemies.push({ pos: c.pos, vel: c.vel, alive: true });
        }
        for (const b of this.deps.enemyBots?.() ?? []) {
          if (!b.alive) continue;
          this._enemies.push(b);
        }
        const shot = t.update(dt, this.deps.scene, this._enemies);
        if (!shot) return;
        this.spawnTracer(shot.muzzle, shot.hit);
        sfx.shotAt(shot.muzzle, 12); // pistol crack — light sentry bark
        this.applyTurretHit(shot.hit);
      },
      dispose: () => t.dispose(this.deps.scene),
    };
    // Keep item.dead in step with the entity's — gnaw damage lands on `t`.
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (t.dead) this.killItem(item); };
    this.items.push(item);
  }

  private applyTurretHit(hit: THREE.Vector3): void {
    // Hitscan: nearest enemy to the aim point within a forgiving radius —
    // the lead math aims at center-mass, so 1.2m covers fast movers.
    let best: Targetable | null = null, bd = 1.44;
    for (const c of this.deps.targets) {
      if (c.dead || c.scoreless) continue;
      const d2 = c.pos.distanceToSquared(hit);
      if (d2 < bd) { bd = d2; best = c; }
    }
    if (best) this.deps.lazyCombat()?.hitTargetLocal(best, TURRET_DMG);
    else {
      for (const b of this.deps.enemyBots?.() ?? []) {
        if (!b.alive) continue;
        if (b.pos.distanceToSquared(hit) < 2.5) {
          this.deps.damageBot?.(b.playerId, TURRET_DMG, hit);
          break;
        }
      }
    }
    this.deps.lazyEffects().spawnMoveDust(hit, this._zeroVel, 2, 0.2);
  }

  private plantMine(pos: THREE.Vector3): void {
    const m = new Mine(this.deps.scene, this.deps.lazyTerrain(), pos);
    const player = this.deps.lazyPlayer();
    m.onDetonate = (mine) => {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, mine.pos, false, 0, this.deps.lazyTerrain(),
        mine.blastRadius / ROCKET_RADIUS, 0xffaa44));
      sfx.explosionAt(mine.pos, true);
      screenShake.blast(mine.pos, 2.5, player.pos);
      // Friendly mine — creatures + enemy bots take the blast, not you.
      for (const c of this.deps.targets) {
        if (c.dead) continue;
        const d = c.pos.distanceTo(mine.pos);
        if (d < mine.blastRadius) {
          const dmg = Math.round(MINE_DAMAGE_MAX * (1 - d / mine.blastRadius));
          if (dmg > 0) this.deps.lazyCombat()?.hitTargetLocal(c, dmg);
        }
      }
      for (const b of this.deps.enemyBots?.() ?? []) {
        const d = b.pos.distanceTo(mine.pos);
        if (b.alive && d < mine.blastRadius) {
          const dmg = Math.round(MINE_DAMAGE_MAX * (1 - d / mine.blastRadius));
          if (dmg > 0) this.deps.damageBot?.(b.playerId, dmg, mine.pos);
        }
      }
    };
    const nearest = new THREE.Vector3();
    const item: Item = {
      kind: 'mine', candId: `dep:${m.id}`, pos: m.pos, dead: false,
      hurt: (dmg) => { void dmg; m.takeDamage(); }, // mines pop on any hit
      update: (dt) => {
        // Trigger proxy: the nearest hostile to THIS mine. Mine.update was
        // written for player-proximity; we feed it our enemy instead.
        let bx = 0, by = 0, bz = 0, bd = Infinity;
        for (const c of this.deps.targets) {
          if (c.dead || c.scoreless) continue;
          const d2 = c.pos.distanceToSquared(m.pos);
          if (d2 < bd) { bd = d2; bx = c.pos.x; by = c.pos.y; bz = c.pos.z; }
        }
        for (const b of this.deps.enemyBots?.() ?? []) {
          if (!b.alive) continue;
          const d2 = b.pos.distanceToSquared(m.pos);
          if (d2 < bd) { bd = d2; bx = b.pos.x; by = b.pos.y; bz = b.pos.z; }
        }
        if (bd === Infinity) return; // nothing hostile alive — stay dormant
        nearest.set(bx, by, bz);
        m.update(dt, nearest);
        if (m.dead) this.killItem(item);
      },
      dispose: () => m.dispose(),
    };
    this.items.push(item);
  }

  private killItem(item: Item): void {
    if (item.dead) return;
    item.dead = true;
    if (item.kind === 'turret') {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 1.4, 0xff7744));
      sfx.explosionAt(item.pos, true);
      screenShake.blast(item.pos, 2, this.deps.lazyPlayer().pos);
    }
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const g = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0x88ddff, transparent: true, blending: THREE.AdditiveBlending,
    }));
    this.deps.scene.add(line);
    this.tracers.push({ line, t: 0.12 });
  }

  /** Creature contact damage — speciesKit calls this when a committed
   *  hunter is gnawing on a deployable. dmg is per-tick-scaled by caller. */
  hurt(candId: string, dmg: number): void {
    const it = this.items.find(i => i.candId === candId && !i.dead);
    it?.hurt(dmg);
  }

  /** Creature-targeting candidates — deployed items aggro the wildlife. */
  candidates(): TargetCandidate[] {
    this._candList.length = 0;
    for (const i of this.items) {
      if (!i.dead) this._candList.push({ id: i.candId, pos: i.pos, vel: this._zeroVel, alive: true });
    }
    return this._candList;
  }

  get count(): number { return this.items.filter(i => !i.dead).length; }

  update(dt: number): void {
    for (const i of this.items) if (!i.dead) i.update(dt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.dead) { this.items[i]!.dispose(); this.items.splice(i, 1); }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i]!;
      tr.t -= dt;
      (tr.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, tr.t / 0.12);
      if (tr.t <= 0) {
        this.deps.scene.remove(tr.line);
        tr.line.geometry.dispose();
        (tr.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
  }
}
