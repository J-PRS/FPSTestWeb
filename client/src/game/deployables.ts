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
import { DeployBeacon } from '../entities/DeployBeacon.js';
import type { SweepObstacle } from '../projectiles/Projectile.js';
import { Explosion } from '../effects/explosion.js';
import { DeployRockets } from './deployRockets.js';
import { DeployAdopter } from './deployAdopt.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { GRAVITY, BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { WeaponType, REPAIR_ARMOR_MULT, DEPLOY_COST } from '../../../shared/weapons.js';
import { weaponDef } from '../weapons.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { THROW_RELEASE, THROW_TOTAL } from '../entities/ViewModel.js';
import type { GameContext } from './context.js';
import type { Targetable } from '../entities/balls.js';
import type { TargetCandidate } from './targeting.js';

export type { DeployKind } from '../../../shared/deployables.js';
import { DEPLOY_KINDS, DEPLOY_MAX, type DeployKind } from '../../../shared/deployables.js';
import { RemoteDeployables } from './remoteDeployables.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

// Derived from the shared belt registry — caps/labels can no longer diverge
// from the server authority (drone max 1 vs 2 did once).
export const DEPLOY_DEFS: { kind: DeployKind; label: string; max: number }[] =
  DEPLOY_KINDS.map((kind) => ({ kind, label: DEPLOY_ITEMS[kind].label.toUpperCase(), max: DEPLOY_MAX[kind] }));

// Sentry mini-rockets live in deployRockets.ts — a real flying body with
// mild homing, smoke trail, and a blast on contact.
const DEPLOY_SLOPE = 0.75; // normal.y floor — can't plant on cliffs
const POD_SPEED = 30;      // throw velocity along the crosshair
const POD_INHERIT = 0.6;   // fraction of player velocity carried into the toss
const POD_RADIUS = 0.32;
const POD_TTL = 8;         // airtime budget — a pod that never settles fizzles
const NUGGET_LOB = 0.55;   // fraction of pod speed — a nugget lobs, not launches
// Nugget pod visual — identical to the Nugget pickup it lands as
// (entities/Nugget.ts): faceted gold icosa + additive halo. What leaves
// your hand must read as the thing you'll pick back up.
const NUG_POD_GEO = new THREE.IcosahedronGeometry(0.3, 0);
const NUG_POD_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xFFEE88).multiplyScalar(EMIT_GAIN) });
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
  nugget?: THREE.Mesh; // pure visual — lands as a pickup, not an item
  beacon?: DeployBeacon;
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
  /** The live emitter — lets the aim solve tilt its sky shaft. */
  beacon?: DeployBeacon;
  /** Base-asset lifecycle — deployDown deploys the wreck state (dims
   *  glow, slumps silhouette) without removing the item: it can still
   *  be welded back or respawn on the server clock. */
  downed?: boolean;
  setDown?: (down: boolean) => void;
}


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
  /** Offline nugget mint — connected play uses the server's pickup edge,
   *  disconnected drops a local nugget so the pack still works solo. */
  dropNugget?: (pos: THREE.Vector3) => void;
  /** World camera — the beacon's HUD aim reticle projects through it. */
  camera: THREE.Camera;
}

export class Deployables {
  private items: Item[] = [];
  private pods: Pod[] = [];

  private readonly _zeroVel = new THREE.Vector3();
  private readonly _candList: TargetCandidate[] = [];
  private readonly _enemies: Foe[] = [];

  constructor(private deps: DeployDeps) {
    this.rockets = new DeployRockets(deps);
    this.remotes = new RemoteDeployables(deps, this.rockets, () => this._enemies);
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
    if (p.throwLockT > 0) {return;} // mid-throw — the gun hand is busy
    // Pack gear pays from the belt pool — the server bills handleDeploy
    // the same DEPLOY_COST when the pod seats.
    if (p.beltCharges < DEPLOY_COST) {return;}
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
      if (p.isDead) {return;} // corpse doesn't release the wind-up
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
      vel: dir.multiplyScalar(POD_SPEED * (kind === 'nugget' ? NUGGET_LOB : 1)).addScaledVector(p.vel, POD_INHERIT),
      ttl: POD_TTL, landed: false,
    };
    // The item is constructed at release — it flies folded and finishes
    // unfolding mid-air, so touchdown lands a full-size sentry/dome.
    if (kind === 'turret') {pod.turret = new DeployTurret(this.deps.scene, terrain, pos);}
    else if (kind === 'station') {pod.station = new DeployStation(this.deps.scene, terrain, pos);}
    else if (kind === 'drone') {pod.drone = new DeployDrone(this.deps.scene, terrain, pos);}
    else if (kind === 'shield') {pod.shield = new DeployShield(this.deps.scene, terrain, pos);}
    else if (kind === 'nugget') {
      pod.nugget = new THREE.Mesh(NUG_POD_GEO, NUG_POD_MAT);
      pod.nugget.position.copy(pos);
      pod.nugget.layers.enable(BLOOM_LAYER);
      // Same additive halo the pickup wears — the pickup read at distance.
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(32), color: 0xff_d5_4a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(2.2);
      pod.nugget.add(halo);
      this.deps.scene.add(pod.nugget);
    }
    else if (kind === 'beacon') {pod.beacon = new DeployBeacon(this.deps.scene, terrain, pos);}
    // Server-tracked life: the planted mine lives its wire ttl, not the
    // overlord field's 45s — the server still explodes it either way.
    else {pod.mine = new Mine(this.deps.scene, terrain, pos, false, DEPLOY_ITEMS.mine.ttlS);}
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
    } else if (pod.nugget) {
      pod.nugget.position.copy(pod.pos);
      pod.nugget.rotation.y += dt * 9;  // tumble — the pickup's own two-axis spin, faster in flight
      pod.nugget.rotation.x += dt * 3.6;
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.update(dt, _FAR); // airborne — nobody to trigger on
    } else if (pod.beacon) {
      pod.beacon.tickUnfold(dt);
      pod.beacon.group.rotation.y += dt * 4;
      pod.beacon.pos.copy(pod.pos);
      pod.beacon.group.position.copy(pod.pos);
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
    } else if (pod.beacon) {
      pod.beacon.pos.copy(pod.pos);
      pod.beacon.group.position.copy(pod.pos);
      pod.beacon.group.quaternion.setFromUnitVectors(_UP, n);
      pod.beacon.unfoldDone();
      this.adopter.adoptBeacon(pod.beacon, undefined);
      pod.beacon = undefined;
    } else if (pod.nugget) {
      // Nothing seats — the pod IS the payload. Connected, the deploy
      // claim below mints the server pickup whose spawn edge paints the
      // resting gem; offline, drop a local nugget in its place.
      if (!this.deps.lazyNetworkManager().isConnected()) {
        this.deps.dropNugget?.(pod.pos);
      }
      this.disposeNuggetPod(pod.nugget);
      pod.nugget = undefined;
    }
    this.deps.lazyEffects().spawnMoveDust(pod.pos, this._zeroVel, 10, 0.6);
    sfx.land(impact);
    this.deps.lazyPlayer().beltCharges = Math.max(0, this.deps.lazyPlayer().beltCharges - DEPLOY_COST);
    this.deps.lazyNetworkManager().sendDeploy(pod.kind, pod.pos);
  }

  /** Bot-authored plant — the brain already chose the landing spot, so
   *  the item arrives directly (mirrors the server's handleDeploy, not
   *  the player's thrown pod). Per-owner kind caps apply. */
  plantFor(kind: DeployKind, pos: { x: number; y: number; z: number }, owner: DeployOwner): void {
    const def = DEPLOY_DEFS.find(d => d.kind === kind);
    if (!def) {return;}
    const live = this.items.filter(i => i.kind === kind && !i.dead && i.owner === owner.id);
    if (live.length >= def.max) {live[0]!.dead = true;}
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
    } else if (kind === 'nugget') {
      this.deps.dropNugget?.(at);
    } else if (kind === 'beacon') {
      const b = new DeployBeacon(this.deps.scene, terrain, at);
      b.unfoldDone();
      this.adopter.adoptBeacon(b, owner);
    } else {
      const m = new Mine(this.deps.scene, terrain, at, false, DEPLOY_ITEMS.mine.ttlS);
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
      if (c.dead || c.scoreless) {continue;}
      this._enemies.push({ pos: c.pos, vel: c.vel, alive: true });
    }
    if (owner) {
      for (const b of this.deps.botFoes?.(owner.team) ?? []) {
        if (b.alive) {this._enemies.push(b);}
      }
    } else {
      for (const b of this.deps.enemyBots?.() ?? []) {
        if (b.alive) {this._enemies.push(b);}
      }
    }
    return this._enemies;
  }

  // --- Remote deployables -------------------------------------------------
  // Server-owned items other players planted + map-authored base assets.
  // The whole layer lives in remoteDeployables.ts (split when the base
  // visuals grew past the ~900-line file ceiling); these are thin routes.
  private readonly remotes: RemoteDeployables;

  /** deploySpawn echo for a plant we already rendered locally. */
  ackLocal(id: number): void {
    this.remotes.ackLocal(id, this.items);
  }

  remoteSpawn(id: number, spec: { owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }): void {
    this.remotes.spawn(id, spec);
  }

  /** deployHp broadcast — server is the vitals authority; the local
   *  beam's predicted heal gets corrected by this same write. */
  applyDeployHp(id: number, hp: number, armor: number): void {
    this.remotes.applyDeployHp(id, hp, armor);
  }

  remoteDown(id: number): void { this.remotes.down(id); }
  remoteUp(id: number): void { this.remotes.up(id); }

  /** Repair-beam pick: nearest deployed item along the ray, padded —
   *  beam thin but not needle-thin, aim at the body not the feet.
   *  Scans remote items too — without it a welder could only ever reach
   *  their OWN plants, so teammates' gear and base assets couldn't be
   *  repaired by a human at all (server accepted the claims; the ray
   *  just never found a target). */
  repairHit(origin: THREE.Vector3, dir: THREE.Vector3, range: number): { item: Item; t: number } | null {
    let best: Item | null = null;
    let bestT = range;
    for (const list of [this.items, this.remotes.values()]) {for (const i of list) {
      if (i.dead) {continue;}
      _repTo.copy(i.pos).sub(origin);
      _repTo.y += 0.7; // body center — turret mast / pad crystal / drone hull
      const proj = _repTo.dot(dir);
      if (proj < 0 || proj > bestT) {continue;}
      const perp2 = _repTo.lengthSq() - proj * proj;
      const r = 1.1;
      if (perp2 >= r * r) {continue;}
      const entry = proj - Math.sqrt(r * r - perp2);
      if (entry < bestT) { bestT = Math.max(entry, 0); best = i; }
    }}
    return best ? { item: best, t: bestT } : null;
  }

  /** Repair beam: heal to maxHealth, overflow banks as armor. The local
   *  write is the offline authority AND the prediction — the server's
   *   deployHp echo lands the same number when connected. */
  healItem(item: Item, n: number): void {
    const {v} = item;
    const over = Math.max(0, v.health + n - v.maxHealth);
    v.health = Math.min(v.maxHealth, v.health + n);
    v.armor = Math.min(v.maxHealth * REPAIR_ARMOR_MULT, v.armor + over);
  }

  // --- Bot welding ---------------------------------------------------------
  // Offline/local bot brains see damaged friendly gear through the same
  // channel the server senses feed theirs: nearest wounded item they own
  // or their team planted. The key mirrors the server's opaque dep id so
  // the brain's `repair` intent resolves identically on both hosts.

  private keyOf(i: Item): string {
    return i.serverId === undefined ? i.candId : `s${i.serverId}`;
  }

  /** Nearest damaged item the bot could weld — own gear always, same-team
   *  gear when the item knows its owner's side. 45m mirrors the server
   *  senses' reach so offline welders behave like wire ones. */
  repairJob(botId: string, team: string, pos: THREE.Vector3): { key: string; pos: THREE.Vector3; frac: number } | null {
    let bestD = 45;
    const scan = (list: Iterable<Item>): Item | null => {
      let best: Item | null = null;
      for (const i of list) {
        if (i.dead || i.v.health >= i.v.maxHealth) {continue;}
        if (i.owner !== botId && i.team !== team) {continue;}
        const d = Math.hypot(i.pos.x - pos.x, i.pos.z - pos.z);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };
    const best = scan(this.items) ?? scan(this.remotes.values());
    return best ? { key: this.keyOf(best), pos: best.pos, frac: best.v.health / best.v.maxHealth } : null;
  }

  /** Resolve a brain's repair key to a heal — returns the welded item so
   *  the caller can paint the work, null when the item died mid-walk. */
  weld(key: string, n: number): Item | null {
    const find = (list: Iterable<Item>) => {
      for (const i of list) {if (this.keyOf(i) === key && !i.dead) {return i;}}
      return null;
    };
    const item = find(this.items) ?? find(this.remotes.values());
    if (!item) {return null;}
    this.healItem(item, n);
    return item;
  }

  // --- Remote welders' beams, pings, shot/boom relays — all inside
  // RemoteDeployables; these keep the public surface stable. -----------

  remoteWeld(srcId: string, serverId: number): void {
    this.remotes.remoteWeld(srcId, serverId);
  }

  remoteRemove(id: number): void {
    this.remotes.remove(id);
  }

  /** Wire-id → item pairs across BOTH lanes: remote spawns keyed by the
   *  map, plus our own plants once ackLocal stamped their serverId.
   *  Feeds the §4.7 deployable fidelity hash — the server's roster
   *  covers our plants too. */
  netEntries(): [number, Item][] {
    const out: [number, Item][] = [...this.remotes.entries()];
    for (const i of this.items) {
      if (i.serverId !== undefined && !i.dead) {out.push([i.serverId, i]);}
    }
    return out;
  }

  remoteIds(): ReadonlySet<number> {
    return this.remotes.ids();
  }

  sensorPing(id: number, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]): void {
    this.remotes.sensorPing(id, team, targets);
  }

  remoteTurretShot(id: number, targetId: string): void {
    this.remotes.turretShot(id, targetId);
  }

  remoteSentryShot(id: number, owner: string, x: number, y: number, z: number): void {
    this.remotes.sentryShot(id, owner, x, y, z);
  }

  remoteMineBoom(id: number, pos: { x: number; y: number; z: number }): void {
    this.remotes.mineBoom(id, pos);
  }



  // Sentry mini-rockets — see deployRockets.ts.
  private readonly rockets: DeployRockets;
  private readonly adopter: DeployAdopter;

  /** Escort drone — follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */




  /** Recharge pad — standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */


  /** Pod teardown — the geo/mat are module-shared (don't dispose), but
   *  the halo sprite's per-instance material must go. */
  private disposeNuggetPod(mesh: THREE.Mesh): void {
    this.deps.scene.remove(mesh);
    for (const c of mesh.children) {
      if (c instanceof THREE.Sprite) {c.material.dispose();}
    }
  }

  private killItem(item: Item): void {
    if (item.dead) {return;}
    item.dead = true;
    if (item.kind === 'station' || item.kind === 'drone' || item.kind === 'shield') {
      // Fizzle-pop — smaller than the turret's, still tells you it died.
      const tint = item.kind === 'drone' ? 0x88_dd_ff : item.kind === 'shield' ? 0x66_cc_ff : 0x55FFCC;
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 0.9, tint));
      sfx.explosionAt(item.pos, false);
    } else if (item.kind === 'turret') {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 1.4, 0xFF7744));
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
      if (!i.dead && i.kind === 'shield') {out.push(this.domeObstacle(i, false));}
    }
    for (const i of this.remotes.values()) {
      if (!i.dead && i.kind === 'shield') {out.push(this.domeObstacle(i, true));}
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
      return shooterId != null && Boolean(this.deps.enemyBots?.().some(b => b.playerId === shooterId));
    }
    // Bot-owned dome: the bot's foe list names who's hostile; 'local'
    // covers the player's own shells (shooterId null → 'local').
    const shooter = shooterId ?? 'local';
    return Boolean(this.deps.botFoes?.(i.team ?? '').some(f => f.playerId === shooter));
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
    if (i.team !== undefined && shooterTeam !== undefined) {return shooterTeam !== i.team;}
    return (shooterId ?? me) !== i.owner;
  }

  /** Creature-targeting candidates — deployed items aggro the wildlife. */
  candidates(): TargetCandidate[] {
    this._candList.length = 0;
    for (const i of this.items) {
      if (!i.dead) {this._candList.push({ id: i.candId, pos: i.pos, vel: this._zeroVel, alive: true });}
    }
    return this._candList;
  }

  get count(): number { return this.items.filter(i => !i.dead).length; }

  update(dt: number): void {
    for (const i of this.items) {if (!i.dead) {i.update(dt);}}

    for (let i = this.pods.length - 1; i >= 0; i--) {
      const pod = this.pods[i]!;
      this.updatePod(pod, dt);
      if (pod.ttl <= 0) {
        pod.turret?.dispose(this.deps.scene);
        pod.station?.dispose(this.deps.scene);
        pod.drone?.dispose(this.deps.scene);
        pod.shield?.dispose(this.deps.scene);
        pod.beacon?.dispose(this.deps.scene);
        pod.mine?.dispose();
        if (pod.nugget) {this.disposeNuggetPod(pod.nugget);}
        this.pods.splice(i, 1);
      }
    }
    this.reapDeadItems();
    this.remotes.update(dt);
    this.rockets.update(dt);
    this.updateBeaconAim();
  }

  // --- Targeting beacon aim reticle -----------------------------------------
  // Own beacon → HUD diamond marking where to point the current weapon so
  // the shell lands on it. Gravity guns get the solved high-arc lob
  // (T2 mortar read); flat-trajectory weapons aim straight at the post.
  private readonly _beaconOrigin = new THREE.Vector3();
  private readonly _beaconAim = new THREE.Vector3();
  private readonly _beaconLob = new THREE.Vector3();
  private readonly _beaconDir = new THREE.Vector3();

  private updateBeaconAim(): void {
    const beacon = this.items.find(i => i.kind === 'beacon' && !i.dead && i.owner === undefined);
    const hud = this.deps.lazyHud();
    const cam = this.deps.camera;
    if (!beacon) { hud.updateBeaconAim(null, null, cam, true); return; }
    const p = this.deps.lazyPlayer();
    const cfg = getProjectileConfig(weaponDef(p.currentWeapon).weaponType);
    cam.getWorldPosition(this._beaconOrigin);
    const o = this._beaconOrigin;
    const t = beacon.pos;
    const dx = t.x - o.x, dz = t.z - o.z;
    const dy = (t.y + 0.6) - o.y; // aim at the emitter, not the dirt
    const d = Math.hypot(dx, dz);
    if (!cfg || cfg.speed <= 0 || d < 1) { hud.updateBeaconAim(null, null, cam, true); return; }
    if (!cfg.gravity) {
      // Flat gun — the reticle IS the beacon; still worth marking.
      beacon.beacon?.setAim(_UP, 40);
      this._beaconAim.set(t.x, t.y + 0.6, t.z);
      hud.updateBeaconAim(this._beaconAim, null, cam, true);
      return;
    }
    const v = cfg.speed, g = Math.abs(GRAVITY);
    const disc = v * v * v * v - g * (g * d * d + 2 * dy * v * v);
    if (disc < 0) {
      // Out of this gun's arc — flag it so the reticle reads "can't reach"
      // instead of lying about a lob that falls short.
      beacon.beacon?.setAim(_UP, 40);
      this._beaconAim.set(t.x, t.y + 0.6, t.z);
      hud.updateBeaconAim(this._beaconAim, null, cam, false);
      return;
    }
    // Two roots to the lob quadratic: the direct low arc and the T2
    // mortar lob over obstacles — both reticles, distinct styles.
    const sqrtD = Math.sqrt(disc);
    const thetaLow = Math.atan((v * v - sqrtD) / (g * d));
    const thetaLob = Math.atan((v * v + sqrtD) / (g * d));
    const hx = dx / d, hz = dz / d;
    const dist = Math.max(d, 40); // keep the projected point off the near field
    this._beaconAim.set(
      o.x + hx * Math.cos(thetaLow) * dist,
      o.y + Math.sin(thetaLow) * dist,
      o.z + hz * Math.cos(thetaLow) * dist);
    this._beaconLob.set(
      o.x + hx * Math.cos(thetaLob) * dist,
      o.y + Math.sin(thetaLob) * dist,
      o.z + hz * Math.cos(thetaLob) * dist);
    // The sky shaft reaches from the emitter to the exact world point the
    // lob reticle projects — the beam tip and the marker coincide on screen.
    this._beaconDir.subVectors(this._beaconLob, t);
    const beamLen = this._beaconDir.length();
    beacon.beacon?.setAim(this._beaconDir, Math.max(beamLen, 4));
    hud.updateBeaconAim(this._beaconAim, this._beaconLob, cam, true);
  }

  // A server-acked local item also sits in byId — drop it or
  // applyDeployHp/remoteWeld keep resolving a corpse until deployGone.
  private reapDeadItems(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (!item.dead) {continue;}
      if (item.serverId !== undefined) {this.remotes.dropById(item.serverId);}
      item.dispose();
      this.items.splice(i, 1);
    }
  }

  dispose(): void {
    this.remotes.dispose();
    this.rockets.dispose();
  }
}
