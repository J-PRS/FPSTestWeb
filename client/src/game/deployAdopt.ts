/**
 * DeployAdopter — pod-landed entity → Item wiring. Each adopt* method
 * closes over its entity and produces the uniform Item record
 * (update/hurt/dispose/owner) Deployables ticks and kills. Split out so
 * deployables.ts stays about pods, net mirrors, and the item list.
 */
import * as THREE from 'three';
import type { DeployTurret } from '../entities/DeployTurret.js';
import type { Mine } from '../entities/Mine.js';
import type { DeployStation } from '../entities/DeployStation.js';
import type { DeployDrone } from '../entities/DeployDrone.js';
import type { DeployShield } from '../entities/DeployShield.js';
import { DeployStation as StationClass } from '../entities/DeployStation.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { MAX_ENERGY, MINE_DAMAGE_MAX, EXPLOSION_VFX_RADIUS } from '../core/config.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { DeployRockets } from './deployRockets.js';
import type { DeployDeps, DeployOwner, Item } from './deployables.js';

type Foe = { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; playerId?: string };

export interface AdoptHost {
  foesFor(owner?: DeployOwner): Foe[];
  killItem(item: Item): void;
}

export class DeployAdopter {
  constructor(
    private readonly deps: DeployDeps,
    private readonly rockets: DeployRockets,
    private readonly items: Item[],
    private readonly host: AdoptHost,
  ) {}

  adoptTurret(t: DeployTurret, owner?: DeployOwner): void {
    const item: Item = {
      kind: 'turret', candId: t.candId, pos: t.pos, dead: false,
      hurt: (dmg) => t.takeDamage(dmg),
      v: t,
      update: (dt) => {
        const shot = t.update(dt, this.host.foesFor(owner));
        if (!shot) return;
        this.rockets.spawn(shot.muzzle, shot.target, 1, owner?.id);
        sfx.shotAt(shot.muzzle, WeaponType.RocketLauncher); // thump + whoosh
      },
      dispose: () => t.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
    };
    // Keep item.dead in step with the entity's — gnaw damage lands on `t`.
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (t.dead) this.host.killItem(item); };
    this.items.push(item);
  }

  /** Escort drone — follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */
  adoptDrone(d: DeployDrone, owner?: DeployOwner): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'drone', candId: d.candId, pos: d.pos, dead: false,
      hurt: (dmg) => d.takeDamage(dmg),
      v: d,
      update: (dt) => {
        // Anchor is the plant owner — a bot's drone chases the bot.
        const shot = d.update(dt, owner?.pos ?? p.pos, owner ? owner.yaw() : p.yaw, this.host.foesFor(owner));
        if (!shot) return;
        this.rockets.spawn(shot.muzzle, shot.target, 0.6, owner?.id);
        sfx.shotAt(shot.muzzle, WeaponType.RocketLauncher);
      },
      dispose: () => d.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
    };
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (d.dead) this.host.killItem(item); };
    this.items.push(item);
  }

  adoptMine(m: Mine, owner?: DeployOwner): void {
    const player = this.deps.lazyPlayer();
    m.onDetonate = (mine) => {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, mine.pos, false, 0, this.deps.lazyTerrain(),
        mine.blastRadius / EXPLOSION_VFX_RADIUS, 0xffaa44));
      sfx.explosionAt(mine.pos, true);
      screenShake.blast(mine.pos, 2.5, player.pos);
      // Friendly mine — creatures + enemy bots take the blast, not you.
      for (const c of this.deps.targets) {
        if (c.dead) continue;
        const d = c.pos.distanceTo(mine.pos);
        if (d < mine.blastRadius) {
          const dmg = Math.round(MINE_DAMAGE_MAX * (1 - d / mine.blastRadius));
          if (dmg > 0) this.deps.lazyCombat()?.hitTargetLocal(c, dmg, owner?.id);
        }
      }
      for (const b of this.host.foesFor(owner)) {
        if (!b.playerId) continue; // creatures take the blast via targets above
        const d = b.pos.distanceTo(mine.pos);
        // 'local' resolves through the same hit funnel — it routes to
        // hurtLocal on the TeamBots side.
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
      v: m,
      update: (dt) => {
        // Trigger proxy: the nearest hostile to THIS mine. Mine.update was
        // written for player-proximity; we feed it our enemy instead.
        let bx = 0, by = 0, bz = 0, bd = Infinity;
        for (const b of this.host.foesFor(owner)) {
          // Player-sourced mines exclude the owner's teammates; the
          // botFoes list already filters by team for bot owners.
          if (!b.alive) continue;
          const d2 = b.pos.distanceToSquared(m.pos);
          if (d2 < bd) { bd = d2; bx = b.pos.x; by = b.pos.y; bz = b.pos.z; }
        }
        if (bd === Infinity) return; // nothing hostile alive — stay dormant
        nearest.set(bx, by, bz);
        m.update(dt, nearest);
        if (m.dead) this.host.killItem(item);
      },
      dispose: () => m.dispose(),
      owner: owner?.id,
      team: owner?.team,
    };
    this.items.push(item);
  }

  /** Recharge pad — standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */
  adoptStation(s: DeployStation, owner?: DeployOwner): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'station', candId: s.candId, pos: s.pos, dead: false,
      hurt: (dmg) => s.takeDamage(dmg),
      v: s,
      update: (dt) => {
        // Field owner gets the charge — a bot's pad heals the bot.
        const who = owner ?? p;
        if (!s.update(dt, who.pos)) return;
        if (owner) {
          owner.addEnergy(StationClass.JET_RATE * dt);
          owner.heal(StationClass.HP_RATE * dt);
        } else {
          p.energy = Math.min(MAX_ENERGY, p.energy + StationClass.JET_RATE * dt);
          p.heal(StationClass.HP_RATE * dt);
        }
      },
      dispose: () => s.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
    };
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (s.dead) this.host.killItem(item); };
    this.items.push(item);
  }

  /** Barrier dome — the emitter is a plain dep: destructible like any
   *  other; the FIELD blocks hostile shells via the shieldObstacles
   *  sweep (deployables.ts), not through this item's update. */
  adoptShield(s: DeployShield, owner?: DeployOwner): void {
    const item: Item = {
      kind: 'shield', candId: s.candId, pos: s.pos, dead: false,
      hurt: (dmg) => s.takeDamage(dmg),
      v: s,
      update: (dt) => s.update(dt),
      dispose: () => s.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
      flash: () => s.flash(),
    };
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (s.dead) this.host.killItem(item); };
    this.items.push(item);
  }
}
