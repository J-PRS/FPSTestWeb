// Deployables — the base-economy layer. Player presses `deploy` to plant
// the selected pack item ahead of them; `cycleDeploy` picks the item.
//
// Two items in the first tranche:
//   turret  — friendly sentry, lobs homing mini-rockets at hostiles
//   mine    — proximity charge that triggers on ENEMIES (not the planter)
//   station — recharge pad: energy + health while you stand in its field
//   drone   — escort that hovers over your shoulder and fires mini-rockets
//   shield  — barrier dome: hostile shells detonate on the field, yours pass
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
import { DeployShield } from '../entities/DeployShield.js';
import type { SweepObstacle } from '../projectiles/Projectile.js';
import { Explosion } from '../effects/explosion.js';
import { DeployRockets } from './deployRockets.js';
import { DeployAdopter } from './deployAdopt.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { GRAVITY } from '../core/config.js';
import { WeaponType, REPAIR_ARMOR_MULT } from '../../../shared/weapons.js';
import { THROW_RELEASE, THROW_TOTAL } from '../entities/ViewModel.js';
import type { GameContext } from './context.js';
import type { Targetable } from '../entities/balls.js';
import type { TargetCandidate } from './targeting.js';

export type DeployKind = 'turret' | 'mine' | 'station' | 'drone' | 'shield';

export const DEPLOY_DEFS: { kind: DeployKind; label: string; max: number }[] = [
  { kind: 'turret',  label: 'SENTRY',   max: 2 },
  { kind: 'mine',    label: 'MINE',     max: 6 },
  { kind: 'station', label: 'PAD',      max: 1 },
  { kind: 'drone',   label: 'DRONE',    max: 1 },
  { kind: 'shield',  label: 'BARRIER',  max: 1 },
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
const _repTo = new THREE.Vector3(); // repair-beam ray scratch

interface Pod {
  kind: DeployKind;
  // The item itself IS the thrown body — it unfolds in the air and lands
  // already full-size (same read as a Turretter dropping in).
  turret?: DeployTurret;
  mine?: Mine;
  station?: DeployStation;
  drone?: DeployDrone;
  shield?: DeployShield;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  ttl: number;
  landed: boolean;
}

export interface Item {
  kind: DeployKind;
  candId: string;
  pos: THREE.Vector3;
  dead: boolean;
  update: (dt: number) => void;
  dispose: () => void;
  hurt: (dmg: number) => void;
  /** Plant owner — per-owner caps and owner-team foe lists for bots.
   *  Undefined = the local player. */
  owner?: string;
  /** Wire id the server assigned (echoed via deploySpawn). The repair
   *  claim carries only this — the server re-derives the heal itself. */
  serverId?: number;
  /** Vitals the repair beam reads — the entity itself for real items,
   *  a plain record for remote-visual ones. */
  v: { health: number; armor: number; maxHealth: number };
  /** Team of the owner when known (bot DeployOwner.team / deploySpawn
   *  wire field) — dome friend-foe checks read it. */
  team?: string;
  /** Dome lattice flare when the field soaks a shell — shield only. */
  flash?: () => void;
}

// Base hp caps — mirrors the server's HP table + entity maxHealth, used
// for remote-visual items and the armor cap before deployHp lands.
const DEPLOY_V_CAP: Record<DeployKind, number> = { turret: 60, mine: 1, station: 90, drone: 50, shield: 120 };

/** A bot that plants — foe lists, anchors, and heals all read through
 *  this instead of the local player singleton. */
export interface DeployOwner {
  id: string;
  team: string;
  pos: THREE.Vector3;
  yaw(): number;
  heal(n: number): void;
  addEnergy(n: number): void;
}

type Foe = { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; playerId?: string };

export interface DeployDeps extends GameContext {
  scene: THREE.Scene;    // scene exists before deployables is constructed
  targets: Targetable[]; // shared creature surface
  lazyCombat: () => { hitTargetLocal(t: Targetable, dmg: number, attackerId?: string): boolean } | undefined;
  /** Enemy bots the turret may legally shoot (deployer's team excluded). */
  enemyBots?: () => { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
  /** Damage funnel for bot hits — same authority as a player's bolts. */
  damageBot?: (playerId: string, dmg: number, fromPos: THREE.Vector3) => boolean;
  /** Bots hostile to a given team — a bot-owned turret/mine scans these
   *  instead of the local player's enemies. */
  botFoes?: (team: string) => Foe[];
}

export class Deployables {
  private items: Item[] = [];
  private pods: Pod[] = [];

  private readonly _zeroVel = new THREE.Vector3();
  private readonly _candList: TargetCandidate[] = [];
  private readonly _enemies: Foe[] = [];

  constructor(private deps: DeployDeps) {
    this.rockets = new DeployRockets(deps);
    this.adopter = new DeployAdopter(deps, this.rockets, this.items, {
      foesFor: (o) => this.foesFor(o),
      killItem: (i) => this.killItem(i),
    });
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
      if (p.isDead) return; // corpse doesn't release the wind-up
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
    else if (kind === 'shield') pod.shield = new DeployShield(this.deps.scene, terrain, pos);
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
    } else if (pod.shield) {
      pod.shield.tickUnfold(dt);
      pod.shield.group.rotation.y += dt * 4;
      pod.shield.pos.copy(pod.pos);
      pod.shield.group.position.copy(pod.pos);
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
      this.adopter.adoptTurret(t, undefined);
      pod.turret = undefined; // ownership moved — fizzle cleanup must not dispose it
    } else if (pod.station) {
      const s = pod.station;
      s.pos.copy(pod.pos);
      s.group.position.copy(pod.pos);
      s.group.quaternion.setFromUnitVectors(_UP, n);
      s.unfoldDone();
      this.adopter.adoptStation(s, undefined);
      pod.station = undefined;
    } else if (pod.drone) {
      const d = pod.drone;
      d.pos.copy(pod.pos);
      d.group.position.copy(pod.pos);
      d.unfoldDone(); // lifts off from the touchdown spot on its own lift
      this.adopter.adoptDrone(d, undefined);
      pod.drone = undefined;
    } else if (pod.shield) {
      const s = pod.shield;
      s.pos.copy(pod.pos);
      s.group.position.copy(pod.pos);
      s.group.quaternion.setFromUnitVectors(_UP, n);
      s.unfoldDone();
      this.adopter.adoptShield(s, undefined);
      pod.shield = undefined;
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.seatOn(terrain);
      this.adopter.adoptMine(pod.mine, undefined);
      pod.mine = undefined;
    }
    this.deps.lazyEffects().spawnMoveDust(pod.pos, this._zeroVel, 10, 0.6);
    sfx.land(impact);
    this.deps.lazyNetworkManager().sendDeploy(pod.kind, pod.pos);
  }

  /** Bot-authored plant — the brain already chose the landing spot, so
   *  the item arrives directly (mirrors the server's handleDeploy, not
   *  the player's thrown pod). Per-owner kind caps apply. */
  plantFor(kind: DeployKind, pos: { x: number; y: number; z: number }, owner: DeployOwner): void {
    const def = DEPLOY_DEFS.find(d => d.kind === kind);
    if (!def) return;
    const live = this.items.filter(i => i.kind === kind && !i.dead && i.owner === owner.id);
    if (live.length >= def.max) live[0]!.dead = true;
    const terrain = this.deps.lazyTerrain();
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    if (kind === 'turret') {
      const t = new DeployTurret(this.deps.scene, terrain, at);
      t.unfoldDone();
      this.adopter.adoptTurret(t, owner);
    } else if (kind === 'station') {
      const s = new DeployStation(this.deps.scene, terrain, at);
      s.unfoldDone();
      this.adopter.adoptStation(s, owner);
    } else if (kind === 'drone') {
      const d = new DeployDrone(this.deps.scene, terrain, at);
      d.unfoldDone();
      this.adopter.adoptDrone(d, owner);
    } else if (kind === 'shield') {
      const s = new DeployShield(this.deps.scene, terrain, at);
      s.unfoldDone();
      this.adopter.adoptShield(s, owner);
    } else {
      const m = new Mine(this.deps.scene, terrain, at);
      m.seatOn(terrain);
      this.adopter.adoptMine(m, owner);
    }
    this.deps.lazyEffects().spawnMoveDust(at, this._zeroVel, 10, 0.6);
    sfx.land(1);
  }

  /** Foe list for an item: the local player deployment scans creatures
   *  + local-enemy bots; a bot-owned plant scans creatures + ITS team's
   *  enemies (the local player included when hostile). */
  private foesFor(owner?: DeployOwner): Foe[] {
    this._enemies.length = 0;
    for (const c of this.deps.targets) {
      if (c.dead || c.scoreless) continue;
      this._enemies.push({ pos: c.pos, vel: c.vel, alive: true });
    }
    if (owner) {
      for (const b of this.deps.botFoes?.(owner.team) ?? []) {
        if (b.alive) this._enemies.push(b);
      }
    } else {
      for (const b of this.deps.enemyBots?.() ?? []) {
        if (b.alive) this._enemies.push(b);
      }
    }
    return this._enemies;
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
    if (newest) { newest.serverId = id; this.byId.set(id, newest); }
  }

  remoteSpawn(id: number, spec: { owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }): void {
    const { owner, kind, pos, hp, armor, team } = spec;
    if (this.remote.has(id)) return;
    const terrain = this.deps.lazyTerrain();
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    let item: Item;
    if (kind === 'shield') {
      // The dome IS the deployable — no proxy sphere for this kind; the
      // field must be visible or enemies can't read what ate their shell.
      const s = new DeployShield(this.deps.scene, terrain, at);
      s.unfoldDone();
      if (hp !== undefined) { s.health = hp; s.armor = armor ?? 0; }
      item = {
        kind, candId: `rdep:${id}`, pos: s.pos, dead: false,
        hurt: () => {},
        update: (dt) => s.update(dt),
        dispose: () => s.dispose(this.deps.scene),
        v: s, owner, flash: () => s.flash(),
      };
    } else if (kind === 'turret') {
      const t = new DeployTurret(this.deps.scene, terrain, at);
      t.unfoldDone();
      if (hp !== undefined) { t.health = hp; t.armor = armor ?? 0; }
      item = {
        kind, candId: `rdep:${id}`, pos: t.pos, dead: false,
        hurt: () => {}, // server owns its lifetime — deployGone removes it
        // Remote sentries still scan and aim — pure cosmetics, no firing.
        update: (dt) => void t.update(dt, this._enemies),
        dispose: () => t.dispose(this.deps.scene),
        v: t,
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
      item = {
        kind, candId: `rdep:${id}`, pos: group.position, dead: false,
        hurt: () => {}, update, dispose: () => this.deps.scene.remove(group),
        v: { health: hp ?? DEPLOY_V_CAP[kind], armor: armor ?? 0, maxHealth: DEPLOY_V_CAP[kind] },
      };
    }
    item.serverId = id;
    item.team = team;
    this.remote.set(id, item);
    this.byId.set(id, item);
  }

  /** deployHp broadcast — server is the vitals authority; the local
   *  beam's predicted heal gets corrected by this same write. */
  applyDeployHp(id: number, hp: number, armor: number): void {
    const it = this.byId.get(id);
    if (it) { it.v.health = hp; it.v.armor = armor; }
  }

  /** Repair-beam pick: nearest deployed item along the ray, padded —
   *  beam thin but not needle-thin, aim at the body not the feet. */
  repairHit(origin: THREE.Vector3, dir: THREE.Vector3, range: number): { item: Item; t: number } | null {
    let best: Item | null = null;
    let bestT = range;
    for (const i of this.items) {
      if (i.dead) continue;
      _repTo.copy(i.pos).sub(origin);
      _repTo.y += 0.7; // body center — turret mast / pad crystal / drone hull
      const proj = _repTo.dot(dir);
      if (proj < 0 || proj > bestT) continue;
      const perp2 = _repTo.lengthSq() - proj * proj;
      const r = 1.1;
      if (perp2 >= r * r) continue;
      const entry = proj - Math.sqrt(r * r - perp2);
      if (entry < bestT) { bestT = Math.max(entry, 0); best = i; }
    }
    return best ? { item: best, t: bestT } : null;
  }

  /** Repair beam: heal to maxHealth, overflow banks as armor. The local
   *  write is the offline authority AND the prediction — the server's
   *  deployHp echo lands the same number when connected. */
  healItem(item: Item, n: number): void {
    const v = item.v;
    const over = Math.max(0, v.health + n - v.maxHealth);
    v.health = Math.min(v.maxHealth, v.health + n);
    v.armor = Math.min(v.maxHealth * REPAIR_ARMOR_MULT, v.armor + over);
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
    this.rockets.spawn(item.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), target, 1, item.owner);
    sfx.shotAt(item.pos, WeaponType.RocketLauncher);
  }

  /** Server tripped a mine — paint the blast at the reported position.
   *  remoteRemove also arrives (deployGone); either order resolves since
   *  the item may already be gone locally. */
  remoteMineBoom(_id: number, pos: { x: number; y: number; z: number }): void {
    sfx.explosionAt(new THREE.Vector3(pos.x, pos.y, pos.z), true);
  }



  // Sentry mini-rockets — see deployRockets.ts.
  private readonly rockets: DeployRockets;
  private readonly adopter: DeployAdopter;

  /** Escort drone — follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */




  /** Recharge pad — standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */


  private killItem(item: Item): void {
    if (item.dead) return;
    item.dead = true;
    if (item.kind === 'station' || item.kind === 'drone' || item.kind === 'shield') {
      // Fizzle-pop — smaller than the turret's, still tells you it died.
      const tint = item.kind === 'drone' ? 0x88ddff : item.kind === 'shield' ? 0x66ccff : 0x55ffcc;
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

  /** Live domes as projectile obstacles — the sweep layer treats each
   *  shield as a static sphere; `blocks` filters friendlies so your own
   *  fire sails through your field while hostile shells pop on contact. */
  private readonly _shieldObs: SweepObstacle[] = [];
  shieldObstacles(): SweepObstacle[] {
    const out = this._shieldObs;
    out.length = 0;
    for (const i of this.items) {
      if (!i.dead && i.kind === 'shield') out.push(this.domeObstacle(i, false));
    }
    for (const i of this.remote.values()) {
      if (!i.dead && i.kind === 'shield') out.push(this.domeObstacle(i, true));
    }
    return out;
  }

  private domeObstacle(i: Item, remote: boolean): SweepObstacle {
    return {
      pos: i.pos, prevPos: i.pos, radius: DeployShield.RADIUS,
      blocks: (p) => remote ? this.remoteShellHostile(i, p.shooterId) : this.localShellHostile(i, p.shooterId),
      onBlocked: () => i.flash?.(),
    };
  }

  /** Locally-simulated domes (yours or a GameBot's, offline): the foe
   *  tables already resolve who's hostile — a bot's dome shields it from
   *  YOUR shells, your dome eats enemy-bot fire. */
  private localShellHostile(i: Item, shooterId: string | null): boolean {
    if (!i.owner) { // the local player's dome — hostile = enemy bots
      return shooterId != null && !!this.deps.enemyBots?.().some(b => b.playerId === shooterId);
    }
    // Bot-owned dome: the bot's foe list names who's hostile; 'local'
    // covers the player's own shells (shooterId null → 'local').
    const shooter = shooterId ?? 'local';
    return !!this.deps.botFoes?.(i.team ?? '').some(f => f.playerId === shooter);
  }

  /** Remote (server-owned) domes: teammates pass, everyone else eats the
   *  field — the owner's own shells are replicas elsewhere and never run
   *  this sweep anyway. Team unknown → ffa: all but the owner's shots. */
  private remoteShellHostile(i: Item, shooterId: string | null): boolean {
    const nm = this.deps.lazyNetworkManager();
    const me = nm.getLocalPlayerId();
    const shooterTeam = shooterId === null
      ? this.deps.world.localTeam
      : nm.getPlayers().get(shooterId)?.team;
    if (i.team !== undefined && shooterTeam !== undefined) return shooterTeam !== i.team;
    return (shooterId ?? me) !== i.owner;
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
        pod.shield?.dispose(this.deps.scene);
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
