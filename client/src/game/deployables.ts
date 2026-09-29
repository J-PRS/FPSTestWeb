// Deployables — the base-economy layer. Player presses `deploy` to plant
// the selected pack item ahead of them; `cycleDeploy` picks the item.
//
// Two items in the first tranche:
//   turret  — friendly sentry, lobs homing mini-rockets at hostiles
//   mine    — proximity charge that triggers on ENEMIES (not the planter)
//   station — recharge pad: energy + health while you stand in its field
//   drone   — escort that hovers over your shoulder and fires mini-rockets
//
// Deployables are creature-visible: they appear in the species targeting
// candidates (dep:N ids) so the wildlife chews on them — that's the T2
// "defense gets razed" pressure. They are NOT in entities.targets, so the
// owner's own explosives don't grief the base they built.

import * as THREE from 'three';
import { DeployTurret } from '../entities/DeployTurret.js';
import { Mine } from '../entities/Mine.js';
import { DeployStation } from '../entities/DeployStation.js';
import { DeployDrone } from '../entities/DeployDrone.js';
import { Explosion } from '../effects/explosion.js';
import { DeployRockets } from './deployRockets.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { GRAVITY, MAX_ENERGY, MINE_DAMAGE_MAX, ROCKET_RADIUS } from '../core/config.js';
import { WeaponType } from '../../../shared/weapons.js';
import { THROW_RELEASE, THROW_TOTAL } from '../entities/ViewModel.js';
import type { GameContext } from './context.js';
import type { Targetable } from '../entities/balls.js';
import type { TargetCandidate } from './targeting.js';

export type DeployKind = 'turret' | 'mine' | 'station' | 'drone';

export const DEPLOY_DEFS: { kind: DeployKind; label: string; max: number }[] = [
  { kind: 'turret',  label: 'SENTRY',   max: 2 },
  { kind: 'mine',    label: 'MINE',     max: 6 },
  { kind: 'station', label: 'PAD',      max: 1 },
  { kind: 'drone',   label: 'DRONE',    max: 1 },
];

// Sentry mini-rockets live in deployRockets.ts — a real flying body with
// mild homing, smoke trail, and a blast on contact.
const DEPLOY_SLOPE = 0.75; // normal.y floor — can't plant on cliffs
const POD_SPEED = 30;      // throw velocity along the crosshair
const POD_INHERIT = 0.6;   // fraction of player velocity carried into the toss
const POD_RADIUS = 0.32;
const POD_TTL = 8;         // airtime budget — a pod that never settles fizzles
const _UP = new THREE.Vector3(0, 1, 0);
const _FAR = new THREE.Vector3(0, -1e5, 0); // dormant-proxy for flying mines

interface Pod {
  kind: DeployKind;
  // The item itself IS the thrown body — it unfolds in the air and lands
  // already full-size (same read as a Turretter dropping in).
  turret?: DeployTurret;
  mine?: Mine;
  station?: DeployStation;
  drone?: DeployDrone;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  ttl: number;
  landed: boolean;
}

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
}

export class Deployables {
  private items: Item[] = [];
  private pods: Pod[] = [];

  private readonly _zeroVel = new THREE.Vector3();
  private readonly _candList: TargetCandidate[] = [];
  private readonly _enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] = [];

  constructor(private deps: DeployDeps) {
    this.rockets = new DeployRockets(deps);
  }

  /** Pack item is a loadout choice (ESC menu), not a cycle — X throws
   *  whatever you packed. */
  private get selDef() {
    return DEPLOY_DEFS.find(d => d.kind === this.deps.lazyPlayer().packItem) ?? DEPLOY_DEFS[0]!;
  }

  /** Throw the selected pack item — the pod arcs out along the crosshair,
   *  sticks where it lands, then unfolds into the real deployable. */
  deploy(): void {
    const p = this.deps.lazyPlayer();
    const def = this.selDef;
    if (p.throwLockT > 0) return; // mid-throw — the gun hand is busy
    // Belt-throw ceremony: weapon lowers, pod releases at THROW_RELEASE.
    p.throwLockT = THROW_TOTAL;
    this.deps.lazyViewModel?.()?.startThrow();
    const live = this.items.filter(i => i.kind === def.kind && !i.dead);
    if (live.length >= def.max) {
      // T2 rule: a new plant retires your oldest of that kind
      const oldest = live[0]!;
      oldest.dead = true;
    }
    // Aim captured at release, not at keypress — the wind-up is long
    // enough to swing the throw across the sky.
    setTimeout(() => {
      const dir = new THREE.Vector3(
        Math.cos(p.pitch) * Math.sin(p.yaw),
        Math.sin(p.pitch),
        Math.cos(p.pitch) * Math.cos(p.yaw)
      ).normalize();
      this.throwPod(def.kind, p, dir);
    }, THROW_RELEASE * 1000);
  }

  private throwPod(kind: DeployKind, p: { pos: THREE.Vector3; vel: THREE.Vector3 }, dir: THREE.Vector3): void {
    const terrain = this.deps.lazyTerrain();
    const pos = p.pos.clone().addScaledVector(dir, 0.8);
    pos.y += 0.4; // release at chest, not feet
    const pod: Pod = {
      kind, pos,
      vel: dir.multiplyScalar(POD_SPEED).addScaledVector(p.vel, POD_INHERIT),
      ttl: POD_TTL, landed: false,
    };
    // The item is constructed at release — it flies folded and finishes
    // unfolding mid-air, so touchdown lands a full-size sentry/dome.
    if (kind === 'turret') pod.turret = new DeployTurret(this.deps.scene, terrain, pos);
    else if (kind === 'station') pod.station = new DeployStation(this.deps.scene, terrain, pos);
    else if (kind === 'drone') pod.drone = new DeployDrone(this.deps.scene, terrain, pos);
    else pod.mine = new Mine(this.deps.scene, terrain, pos);
    this.pods.push(pod);
    sfx.dash();
  }

  /** Pod flight: gravity arc, the item unfolds mid-air, cliffs deflect it. */
  private updatePod(pod: Pod, dt: number): void {
    const terrain = this.deps.lazyTerrain();
    pod.ttl -= dt;
    pod.vel.y += GRAVITY * dt;
    pod.pos.addScaledVector(pod.vel, dt);

    if (pod.turret) {
      pod.turret.tickUnfold(dt); // assembly completes in the air
      pod.turret.group.rotation.y += dt * 4; // slow tumble reads mass
      pod.turret.pos.copy(pod.pos);
      pod.turret.group.position.copy(pod.pos);
    } else if (pod.station) {
      pod.station.tickUnfold(dt);
      pod.station.group.rotation.y += dt * 4;
      pod.station.pos.copy(pod.pos);
      pod.station.group.position.copy(pod.pos);
    } else if (pod.drone) {
      pod.drone.tickUnfold(dt);
      pod.drone.group.rotation.y += dt * 4;
      pod.drone.pos.copy(pod.pos);
      pod.drone.group.position.copy(pod.pos);
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.update(dt, _FAR); // airborne — nobody to trigger on
    }

    const groundY = terrain.getHeight(pod.pos.x, pod.pos.z);
    if (pod.pos.y - POD_RADIUS <= groundY) {
      const n = terrain.getNormal(pod.pos.x, pod.pos.z);
      if (n.y >= DEPLOY_SLOPE) {
        this.attach(pod, n);
      } else {
        // Cliff face — glance off instead of sticking sideways.
        pod.pos.y = groundY + POD_RADIUS;
        const vn = pod.vel.dot(n);
        pod.vel.addScaledVector(n, -vn * 1.4); // reflect, lose energy
        pod.vel.multiplyScalar(0.4);
      }
    }

  }

  /** Touchdown on landable ground — seat the already-unfolded item and
   *  hand it to the live items list. No post-land growth: it dropped in
   *  full-size like a Turretter. */
  private attach(pod: Pod, n: THREE.Vector3): void {
    const terrain = this.deps.lazyTerrain();
    const impact = Math.abs(pod.vel.y);
    pod.landed = true;
    pod.ttl = 0; // consumed — the item lives in this.items now
    pod.pos.y = terrain.getHeight(pod.pos.x, pod.pos.z);
    if (pod.turret) {
      const t = pod.turret;
      t.pos.copy(pod.pos);
      t.group.position.copy(pod.pos);
      t.group.quaternion.setFromUnitVectors(_UP, n);
      t.group.scale.setScalar(1); // snap any unfolding tail to done
      t.unfoldDone();
      this.adoptTurret(t);
      pod.turret = undefined; // ownership moved — fizzle cleanup must not dispose it
    } else if (pod.station) {
      const s = pod.station;
      s.pos.copy(pod.pos);
      s.group.position.copy(pod.pos);
      s.group.quaternion.setFromUnitVectors(_UP, n);
      s.unfoldDone();
      this.adoptStation(s);
      pod.station = undefined;
    } else if (pod.drone) {
      const d = pod.drone;
      d.pos.copy(pod.pos);
      d.group.position.copy(pod.pos);
      d.unfoldDone(); // lifts off from the touchdown spot on its own lift
      this.adoptDrone(d);
      pod.drone = undefined;
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.seatOn(terrain);
      this.adoptMine(pod.mine);
      pod.mine = undefined;
    }
    this.deps.lazyEffects().spawnMoveDust(pod.pos, this._zeroVel, 10, 0.6);
    sfx.land(impact);
    this.deps.lazyNetworkManager().sendDeploy(pod.kind, pod.pos);
  }

  // --- Remote deployables -------------------------------------------------
  // Server-owned items other players planted. Pure visuals — targeting and
  // damage run on the server (turretShot broadcasts paint the rockets).
  private remote = new Map<number, Item>();
  /** Server id → item for our OWN plants — deploySpawn echoes back to the
   *  owner, letting server-driven events (turretShot) find the visual. */
  private byId = new Map<number, Item>();

  /** deploySpawn echo for a plant we already rendered locally. */
  ackLocal(id: number): void {
    const live = this.items.filter(i => !i.dead);
    const newest = live[live.length - 1];
    if (newest) this.byId.set(id, newest);
  }

  remoteSpawn(id: number, owner: string, kind: DeployKind, pos: { x: number; y: number; z: number }): void {
    if (this.remote.has(id)) return;
    const terrain = this.deps.lazyTerrain();
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    let item: Item;
    if (kind === 'turret') {
      const t = new DeployTurret(this.deps.scene, terrain, at);
      t.unfoldDone();
      item = {
        kind, candId: `rdep:${id}`, pos: t.pos, dead: false,
        hurt: () => {}, // server owns its lifetime — deployGone removes it
        // Remote sentries still scan and aim — pure cosmetics, no firing.
        update: (dt) => void t.update(dt, this._enemies),
        dispose: () => t.dispose(this.deps.scene),
      };
    } else {
      const group = new THREE.Group();
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(kind === 'mine' ? 0.3 : 0.5, 8, 6),
        new THREE.MeshLambertMaterial({ color: kind === 'mine' ? 0x8a5a2a : 0x4a5560 }));
      group.add(m);
      group.position.copy(at);
      group.position.y = terrain.getHeight(at.x, at.z);
      this.deps.scene.add(group);
      // Drones chase their owner's shadow server-side — mirror that anchor
      // here or the visual stays parked at the pod's landing spot.
      const update = kind === 'drone'
        ? () => {
            const op = this.deps.lazyNetworkManager().getPlayers().get(owner)?.position;
            if (op) group.position.set(op.x, op.y + 2.5, op.z);
          }
        : () => {};
      item = { kind, candId: `rdep:${id}`, pos: group.position, dead: false, hurt: () => {}, update, dispose: () => this.deps.scene.remove(group) };
    }
    this.remote.set(id, item);
    this.byId.set(id, item);
  }

  remoteRemove(id: number): void {
    this.byId.delete(id);
    const item = this.remote.get(id);
    if (!item) return;
    this.remote.delete(id);
    item.dispose();
  }

  remoteIds(): ReadonlySet<number> {
    return new Set(this.remote.keys());
  }

  /** Server announced a sentry shot — paint the rocket it represents so
   *  the defender sees the incoming, not just the health loss. */
  remoteTurretShot(id: number, targetId: string): void {
    const item = this.byId.get(id);
    if (!item) return;
    const t = this.deps.lazyNetworkManager().getPlayers().get(targetId);
    const tp = targetId === this.deps.lazyNetworkManager().getLocalPlayerId()
      ? this.deps.lazyPlayer().pos
      : t?.position;
    if (!tp) return;
    // Positions are feet — home at capsule center or the rocket slams
    // terrain at the target's toes (the damage lands regardless, so the
    // visual was reading as "sentry shoots the ground").
    const target = { pos: new THREE.Vector3(tp.x, tp.y + 1.0, tp.z), vel: new THREE.Vector3(), alive: true };
    this.rockets.spawn(item.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), target);
    sfx.shotAt(item.pos, WeaponType.RocketLauncher);
  }

  /** Server tripped a mine — paint the blast at the reported position.
   *  remoteRemove also arrives (deployGone); either order resolves since
   *  the item may already be gone locally. */
  remoteMineBoom(_id: number, pos: { x: number; y: number; z: number }): void {
    sfx.explosionAt(new THREE.Vector3(pos.x, pos.y, pos.z), true);
  }

  private adoptTurret(t: DeployTurret): void {
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
        const shot = t.update(dt, this._enemies);
        if (!shot) return;
        this.rockets.spawn(shot.muzzle, shot.target);
        sfx.shotAt(shot.muzzle, WeaponType.RocketLauncher); // thump + whoosh
      },
      dispose: () => t.dispose(this.deps.scene),
    };
    // Keep item.dead in step with the entity's — gnaw damage lands on `t`.
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (t.dead) this.killItem(item); };
    this.items.push(item);
  }

  // Sentry mini-rockets — see deployRockets.ts.
  private readonly rockets: DeployRockets;

  /** Escort drone — follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */
  private adoptDrone(d: DeployDrone): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'drone', candId: d.candId, pos: d.pos, dead: false,
      hurt: (dmg) => d.takeDamage(dmg),
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
        const shot = d.update(dt, p.pos, p.yaw, this._enemies);
        if (!shot) return;
        this.rockets.spawn(shot.muzzle, shot.target, 0.6);
        sfx.shotAt(shot.muzzle, WeaponType.RocketLauncher);
      },
      dispose: () => d.dispose(this.deps.scene),
    };
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (d.dead) this.killItem(item); };
    this.items.push(item);
  }

  private adoptMine(m: Mine): void {
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

  /** Recharge pad — standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */
  private adoptStation(s: DeployStation): void {
    const p = this.deps.lazyPlayer();
    const item: Item = {
      kind: 'station', candId: s.candId, pos: s.pos, dead: false,
      hurt: (dmg) => s.takeDamage(dmg),
      update: (dt) => {
        if (!s.update(dt, p.pos)) return;
        p.energy = Math.min(MAX_ENERGY, p.energy + DeployStation.JET_RATE * dt);
        p.heal(DeployStation.HP_RATE * dt);
      },
      dispose: () => s.dispose(this.deps.scene),
    };
    const hurt = item.hurt;
    item.hurt = (dmg) => { hurt(dmg); if (s.dead) this.killItem(item); };
    this.items.push(item);
  }

  private killItem(item: Item): void {
    if (item.dead) return;
    item.dead = true;
    if (item.kind === 'station' || item.kind === 'drone') {
      // Fizzle-pop — smaller than the turret's, still tells you it died.
      const tint = item.kind === 'drone' ? 0x88ddff : 0x55ffcc;
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 0.9, tint));
      sfx.explosionAt(item.pos, false);
    } else if (item.kind === 'turret') {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 1.4, 0xff7744));
      sfx.explosionAt(item.pos, true);
      screenShake.blast(item.pos, 2, this.deps.lazyPlayer().pos);
    }
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
    for (const i of this.remote.values()) i.update(dt);
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const pod = this.pods[i]!;
      this.updatePod(pod, dt);
      if (pod.ttl <= 0) {
        pod.turret?.dispose(this.deps.scene);
        pod.station?.dispose(this.deps.scene);
        pod.drone?.dispose(this.deps.scene);
        pod.mine?.dispose();
        this.pods.splice(i, 1);
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.dead) { this.items[i]!.dispose(); this.items.splice(i, 1); }
    }
    this.rockets.update(dt);
  }

  dispose(): void {
    for (const i of this.remote.values()) i.dispose();
    this.remote.clear();
    this.rockets.dispose();
  }
}
