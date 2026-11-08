/**
 * DeployAdopter - pod-landed entity → Item wiring. Each adopt* method
 * closes over its entity and produces the uniform Item record
 * (update/hurt/dispose/owner) Deployables ticks and kills. Split out so
 * deployables.ts stays about pods, net mirrors, and the item list.
 */
import * as THREE from 'three';
import type { DeployTurret } from '../entities/DeployTurret.js';
import type { Mine } from '../entities/Mine.js';
import {type DeployStation, DeployStation as StationClass} from '../entities/DeployStation.js';
import type { DeployDrone } from '../entities/DeployDrone.js';
import type { DeployShield } from '../entities/DeployShield.js';
import type { DeployBeacon } from '../entities/DeployBeacon.js';
import type { DeployTether } from '../entities/DeployTether.js';
import type { DeployWatersphere } from '../entities/DeployWatersphere.js';
import type { DeployPad } from '../entities/DeployPad.js';
import type { DeployLoiter } from '../entities/DeployLoiter.js';
import type { DeploySpider } from '../entities/DeploySpider.js';
import type { DeployJammer } from '../entities/DeployJammer.js';
import type { DeployMotion } from '../entities/DeployMotion.js';
import type { DeployMortar } from '../entities/DeployMortar.js';
import type { DeployCg } from '../entities/DeployCg.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { structureNormalAt } from './structureSpecs.js';
import { Projectile } from '../projectiles/Projectile.js';
import { MORTAR_CONFIG } from '../projectiles/mortarConfig.js';
import { GRENADE_CONFIG } from '../projectiles/grenadeConfig.js';
import { CHAINGUN_CONFIG } from '../projectiles/chaingunConfig.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { MAX_ENERGY, MINE_DAMAGE_MAX, EXPLOSION_VFX_RADIUS } from '../core/config.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { DeployRockets } from './deployRockets.js';
import type { DeployDeps, DeployOwner, Item } from './deployables.js';

type Foe = { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; playerId?: string };

const _zeroVel = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _padDv = new THREE.Vector3();
const _padN = new THREE.Vector3();

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

  /** Shared adoption ceremony: the Item literal + the dead-sync hurt
   *  wrapper + the push. Mine keeps its own (hits detonate, not hurt).
   *  Kinds pass a body with candId/pos/takeDamage/dead/dispose and their
   *  bespoke update body. */
  private mkItem<T extends { candId: string; pos: THREE.Vector3; dead: boolean; health: number; armor: number; maxHealth: number;
    takeDamage(dmg: number): void; dispose(scene: THREE.Scene): void }>(
    kind: DeployKind, body: T, owner: DeployOwner | undefined, update: Item['update'], extra?: Partial<Item>,
  ): Item {
    const item: Item = {
      kind, candId: body.candId, pos: body.pos, dead: false,
      hurt: (dmg): void => body.takeDamage(dmg),
      v: body, update,
      dispose: (): void => body.dispose(this.deps.scene),
      owner: owner?.id, team: owner?.team,
      ...extra,
    };
    const {hurt} = item;
    item.hurt = (dmg): void => { hurt(dmg); if (body.dead) {this.host.killItem(item);} };
    this.items.push(item);
    return item;
  }

  adoptTurret(t: DeployTurret, owner?: DeployOwner): void {
    this.mkItem('turret', t, owner, (dt): void => {
      const shot = t.update(dt, this.host.foesFor(owner));
      if (!shot) {return;}
      this.rockets.spawn(shot.muzzle, shot.target, 1, owner?.id);
      sfx.shotAt(shot.muzzle, WeaponType.MissileLauncher); // thump + whoosh
    });
  }

  /** Escort drone - follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */
  adoptDrone(d: DeployDrone, owner?: DeployOwner): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'drone', candId: d.candId, pos: d.pos, dead: false,
      hurt: (dmg): void => d.takeDamage(dmg),
      v: d,
      update: (dt): void => {
        // Anchor is the plant owner - a bot's drone chases the bot.
        const shot = d.update(dt, owner?.pos ?? p.pos, owner ? owner.yaw() : p.yaw, this.host.foesFor(owner));
        if (!shot) {return;}
        this.rockets.spawn(shot.muzzle, shot.target, 0.6, owner?.id);
        sfx.shotAt(shot.muzzle, WeaponType.MissileLauncher);
      },
      dispose: (): void => d.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
    };
    const {hurt} = item;
    item.hurt = (dmg): void => { hurt(dmg); if (d.dead) {this.host.killItem(item);} };
    this.items.push(item);
  }

  /** Mortar turret - lobs the REAL player-mortar shell (arming fuse,
   *  thud-bounce, 18m splash) at hostiles in its [minRange, range] band.
   *  Offline the local Projectile carries the blast through the normal
   *  funnel; connected the server owns the shot - the mortarShot wire
   *  event paints the same arc as a replica. */
  adoptMortar(m: DeployMortar, owner?: DeployOwner): void {
    this.mkItem('mortar', m, owner,       (dt): void => {
        const shot = m.update(dt, this.host.foesFor(owner));
        if (!shot || this.deps.lazyNetworkManager().isConnected()) {return;}
        const p = new Projectile(this.deps.scene, shot.muzzle, _shotDir.copy(shot.vel).normalize(), _zeroVel, MORTAR_CONFIG);
        p.vel.copy(shot.vel); // exact solved arc - ctor's inherit math is for held weapons
        p.shooterId = owner?.id ?? null;
        p.shooterTeam = owner?.team ?? null;
        if (owner) { // a bot-owned shell can hit the local player; your own can't (same law as bot lobs)
          p.sweepLocal = (): THREE.Vector3 | null => { const pl = this.deps.lazyPlayer(); return pl.isDead ? null : pl.pos; };
          p.localClass = (): string | undefined => this.deps.lazyPlayer().appliedClass;
        }
        this.deps.world.projectiles.push(p);
        sfx.shotAt(shot.muzzle, WeaponType.Mortar);
      });
  }

  /** Chaingun turret - real CG bolts (weapon row 3) at ~7/s over a
   *  LOS-gated envelope. Offline each bolt carries the honest sweep;
   *  connected the server's turretShot pulse owns damage and paints a
   *  tracer burst instead (remoteDeployables branches on kind). */
  adoptCg(c: DeployCg, owner?: DeployOwner): void {
    this.mkItem('cgturret', c, owner,       (dt): void => {
        const shot = c.update(dt, this.host.foesFor(owner));
        if (!shot || this.deps.lazyNetworkManager().isConnected()) {return;}
        const p = new Projectile(this.deps.scene, shot.muzzle, _shotDir.copy(shot.vel).normalize(), _zeroVel, CHAINGUN_CONFIG);
        p.vel.copy(shot.vel);
        p.shooterId = owner?.id ?? null;
        p.shooterTeam = owner?.team ?? null;
        if (owner) {
          p.sweepLocal = (): THREE.Vector3 | null => { const pl = this.deps.lazyPlayer(); return pl.isDead ? null : pl.pos; };
          p.localClass = (): string | undefined => this.deps.lazyPlayer().appliedClass;
        }
        this.deps.world.projectiles.push(p);
      });
  }

  adoptMine(m: Mine, owner?: DeployOwner): void {
    const player = this.deps.lazyPlayer();
    m.onDetonate = (mine): void => {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, mine.pos, false, 0, this.deps.lazyTerrain(),
        mine.blastRadius / EXPLOSION_VFX_RADIUS, 0xFF_AA_44));
      sfx.explosionAt(mine.pos, true);
      screenShake.blast(mine.pos, 2.5, player.pos);
      // Friendly mine - creatures + enemy bots take the blast, not you.
      for (const c of this.deps.targets) {
        if (c.dead) {continue;}
        const d = c.pos.distanceTo(mine.pos);
        if (d < mine.blastRadius) {
          const dmg = Math.round(MINE_DAMAGE_MAX * (1 - d / mine.blastRadius));
          if (dmg > 0) {this.deps.lazyCombat()?.hitTargetLocal(c, dmg, owner?.id);}
        }
      }
      for (const b of this.host.foesFor(owner)) {
        if (!b.playerId) {continue;} // creatures take the blast via targets above
        const d = b.pos.distanceTo(mine.pos);
        // 'local' resolves through the same hit funnel - it routes to
        // hurtLocal on the TeamBots side.
        if (b.alive && d < mine.blastRadius) {
          const dmg = Math.round(MINE_DAMAGE_MAX * (1 - d / mine.blastRadius));
          if (dmg > 0) {this.deps.damageBot?.(b.playerId, dmg, mine.pos);}
        }
      }
    };
    const nearest = new THREE.Vector3();
    const item: Item = {
      kind: 'mine', candId: `dep:${m.id}`, pos: m.pos, dead: false,
      hurt: (): void => { m.takeDamage(); }, // mines pop on any hit
      v: m,
      update: (dt): void => {
        // Trigger proxy: the nearest hostile to THIS mine. Mine.update was
        // written for player-proximity; we feed it our enemy instead.
        let bx = 0, by = 0, bz = 0, bd = Infinity;
        for (const b of this.host.foesFor(owner)) {
          // Player-sourced mines exclude the owner's teammates; the
          // botFoes list already filters by team for bot owners.
          if (!b.alive) {continue;}
          const d2 = b.pos.distanceToSquared(m.pos);
          if (d2 < bd) { bd = d2; bx = b.pos.x; by = b.pos.y; bz = b.pos.z; }
        }
        if (bd === Infinity) {return;} // nothing hostile alive - stay dormant
        nearest.set(bx, by, bz);
        m.update(dt, nearest);
        if (m.dead) {this.host.killItem(item);}
      },
      dispose: (): void => m.dispose(),
      owner: owner?.id,
      team: owner?.team,
    };
    this.items.push(item);
  }

  /** Recharge pad - standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */
  adoptStation(s: DeployStation, owner?: DeployOwner): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'station', candId: s.candId, pos: s.pos, dead: false,
      hurt: (dmg): void => s.takeDamage(dmg),
      v: s,
      update: (dt): void => {
        // Field owner gets the charge - a bot's pad heals the bot.
        const who = owner ?? p;
        if (!s.update(dt, who.pos)) {return;}
        if (owner) {
          owner.addEnergy(StationClass.JET_RATE * dt);
          owner.heal(StationClass.HP_RATE * dt);
        } else {
          p.energy = Math.min(MAX_ENERGY, p.energy + StationClass.JET_RATE * dt);
          p.heal(StationClass.HP_RATE * dt);
        }
      },
      dispose: (): void => s.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
    };
    const {hurt} = item;
    item.hurt = (dmg): void => { hurt(dmg); if (s.dead) {this.host.killItem(item);} };
    this.items.push(item);
  }

  /** Targeting beacon - no behavior of its own; the item record exists so
   *  caps/TTL/blasts manage it while Deployables reads its pos for the
   *  mortar-arc HUD reticle. */
  adoptBeacon(b: DeployBeacon, owner?: DeployOwner): void {
    const item: Item = {
      kind: 'beacon', candId: b.candId, pos: b.pos, dead: false,
      hurt: (dmg): void => b.takeDamage(dmg),
      v: b,
      update: (dt): void => b.update(dt),
      dispose: (): void => b.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
      beacon: b,
    };
    const {hurt} = item;
    item.hurt = (dmg): void => { hurt(dmg); if (b.dead) {this.host.killItem(item);} };
    this.items.push(item);
  }

  /** Tether snare - the item only owns the visual; the drag and the energy
   *  zap are judged by the shared sim and the server, not by this record. */
  adoptTether(t: DeployTether, owner?: DeployOwner): void {
    this.mkItem('tether', t, owner, (dt): void => t.update(dt));
  }

  /** Watersphere - the item only owns the dome visual; the wade-drag is
   *  judged by the shared sim and the server, not by this record. */
  adoptWatersphere(w: DeployWatersphere, owner?: DeployOwner): void {
    this.mkItem('watersphere', w, owner, (dt): void => w.update(dt));
  }

  /** Jump pad - offline mirror of the server's tickPad: once armed, ANY
   *  body in the ring (local player or bot, no team check) rides the
   *  surface normal out. Connected the wire carries the launch - this
   *  loop only owns the solo mirror. */
  adoptPad(s: DeployPad, owner?: DeployOwner): void {
    const def = DEPLOY_ITEMS.pad;
    const lastHits = new Map<string, number>();
    this.mkItem('pad', s, owner, (dt): void => {
      s.update(dt);
      if (this.deps.lazyNetworkManager().isConnected() || !s.armed) {return;}
      // The surface the pad sits on keys the launch - structure normal
      // (dome cap / flat top) before terrain, same rule the server runs.
      const n = structureNormalAt(s.pos.x, s.pos.y, s.pos.z, _padN)
        ?? this.deps.lazyTerrain().getNormal(s.pos.x, s.pos.z);
      const sp = def.launchSpeed!;
      _padDv.set(n.x * sp, n.y * sp + 6, n.z * sp);
      const tr2 = def.triggerDist! * def.triggerDist!;
      const p = this.deps.lazyPlayer();
      const now = performance.now();
      const launch = (id: string, pos: THREE.Vector3, vel: THREE.Vector3): void => {
        const dx = pos.x - s.pos.x, dy = pos.y - s.pos.y, dz = pos.z - s.pos.z;
        if (dx * dx + dy * dy + dz * dz >= tr2 || now - (lastHits.get(id) ?? -1e9) < 1500) {return;}
        lastHits.set(id, now);
        vel.add(_padDv);
        s.boing();
        this.deps.lazyEffects().spawnBounce(pos, _padDv);
        sfx.bounce();
      };
      // The local body launches through the real sim impulse (same
      // channel the howitzer recoil uses) - not a raw vel write, so
      // the ungrounded/fall-damage contracts still hold.
      if (!p.isDead && p.pos.distanceToSquared(s.pos) < tr2 && now - (lastHits.get('local') ?? -1e9) >= 1500) {
        lastHits.set('local', now);
        p.movement.impulse(_padDv);
        s.boing();
        this.deps.lazyEffects().spawnBounce(p.pos, _padDv);
        sfx.bounce();
      }
      for (const team of ['alpha', 'bravo']) {
        for (const f of this.deps.botFoes?.(team) ?? []) {
          if (f.alive && f.playerId) {launch(f.playerId, f.pos, f.vel);}
        }
      }
    }, { boing: (): void => s.boing() });
  }

  /** Loiter munition - the dart hovers and watches the ring; on a commit
   *  offline it becomes a REAL grenade-row projectile on the dive line
   *  (honest sweep + blast through the shared funnel). Connected the
   *  server owns the dive - loiterDive paints the swoop, mineBoom the
   *  blast, deployGone the body. */
  adoptLoiter(s: DeployLoiter, owner?: DeployOwner): void {
    const item = this.mkItem('loiter', s, owner, (dt): void => {
      const dive = s.update(dt, this.host.foesFor(owner));
      if (!dive || this.deps.lazyNetworkManager().isConnected()) {return;}
      const p = new Projectile(this.deps.scene, dive.hover, _shotDir.copy(dive.vel).normalize(), _zeroVel, GRENADE_CONFIG);
      p.vel.copy(dive.vel); // the dart's powered line - inherit math is for held weapons
      p.shooterId = owner?.id ?? null;
      p.shooterTeam = owner?.team ?? null;
      if (owner) { // a bot's dart can hit the local player; yours can't (same law as bot lobs)
        p.sweepLocal = (): THREE.Vector3 | null => { const pl = this.deps.lazyPlayer(); return pl.isDead ? null : pl.pos; };
        p.localClass = (): string | undefined => this.deps.lazyPlayer().appliedClass;
      }
      this.deps.world.projectiles.push(p);
      s.dive(dive.hover, dive.vel);
      item.dead = true; // munition spent - the projectile carries the blast
    }, { dive: (p0, v0): void => s.dive(p0, v0) });
  }

  /** Jammer - passive aura; the bubble logic is server-side (the mast's
   *  sweep reads it). The item only owns the visual + damage record. */
  adoptJammer(j: DeployJammer, owner?: DeployOwner): void {
    this.mkItem('jammer', j, owner, (dt): void => j.update(dt));
  }

  /** Motion sensor - same passive shape: detection is the server's
   *  tickMotion feeding the intel table; the replica just sweeps its
   *  eye and marks the ring. */
  adoptMotion(m: DeployMotion, owner?: DeployOwner): void {
    this.mkItem('motion', m, owner, (dt): void => m.update(dt));
  }

  /** Spider mine - ground-scuttler: chases GROUNDED hostiles (air is
   *  the counter), detonates in reach. Offline the blast is the same
   *  funnel the mine paints; connected the server owns the hunt and the
   *  replica just mirrors the crawl (mineBoom lands the truth). */
  adoptSpider(s: DeploySpider, owner?: DeployOwner): void {
    const item = this.mkItem('spider', s, owner, (dt): void => {
      const boom = s.update(dt, this.host.foesFor(owner));
      if (!boom || this.deps.lazyNetworkManager().isConnected()) {return;}
      const def = DEPLOY_ITEMS.spider;
      const player = this.deps.lazyPlayer();
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, s.pos, false, 0, this.deps.lazyTerrain(),
        def.blastRadius! / EXPLOSION_VFX_RADIUS, 0xFF_AA_44));
      sfx.explosionAt(s.pos, true);
      screenShake.blast(s.pos, 2.5, player.pos);
      for (const c of this.deps.targets) {
        if (c.dead) {continue;}
        const d = c.pos.distanceTo(s.pos);
        if (d < def.blastRadius!) {
          const dmg = Math.round(def.blastDamage! * (1 - d / def.blastRadius!));
          if (dmg > 0) {this.deps.lazyCombat()?.hitTargetLocal(c, dmg, owner?.id);}
        }
      }
      for (const b of this.host.foesFor(owner)) {
        if (!b.playerId) {continue;}
        const d = b.pos.distanceTo(s.pos);
        if (b.alive && d < def.blastRadius!) {
          const dmg = Math.round(def.blastDamage! * (1 - d / def.blastRadius!));
          if (dmg > 0) {this.deps.damageBot?.(b.playerId, dmg, s.pos);}
        }
      }
      // killItem, not bare dead=true - the flag alone left the body
      // standing where it went off (the visible corpse bug).
      this.host.killItem(item);
    });
  }

  /** Barrier dome - the emitter is a plain dep: destructible like any
   *  other; the FIELD blocks hostile shells via the shieldObstacles
   *  sweep (deployables.ts), not through this item's update. */
  adoptShield(s: DeployShield, owner?: DeployOwner): void {
    const item: Item = {
      kind: 'shield', candId: s.candId, pos: s.pos, dead: false,
      hurt: (dmg): void => s.takeDamage(dmg),
      v: s,
      update: (dt): void => s.update(dt),
      dispose: (): void => s.dispose(this.deps.scene),
      owner: owner?.id,
      team: owner?.team,
      flash: (): void => s.flash(),
    };
    const {hurt} = item;
    item.hurt = (dmg): void => { hurt(dmg); if (s.dead) {this.host.killItem(item);} };
    this.items.push(item);
  }
}
