// Deployables - the base-economy layer. Player presses `deploy` to plant
// the selected pack item ahead of them; `cycleDeploy` picks the item.
//
// Two items in the first tranche:
//   turret  - friendly sentry, lobs homing mini-rockets at hostiles
//   mine    - proximity charge that triggers on ENEMIES (not the planter)
//   station - recharge pad: energy + health while you stand in its field
//   drone   - escort that hovers over your shoulder and fires mini-rockets
//   shield  - barrier dome: hostile shells detonate on the field, yours pass
//
// Deployables are creature-visible: they appear in the species targeting
// candidates (dep:N ids) so the wildlife chews on them - that's the T2
// "defense gets razed" pressure. They are NOT in entities.targets, so the
// owner's own explosives don't grief the base they built.

import * as THREE from 'three';
import { DeployTurret } from '../entities/DeployTurret.js';
import { DeployMortar } from '../entities/DeployMortar.js';
import { DeployCg } from '../entities/DeployCg.js';
import { Mine } from '../entities/Mine.js';
import { DeployStation } from '../entities/DeployStation.js';
import { DeployDrone } from '../entities/DeployDrone.js';
import { DeployShield } from '../entities/DeployShield.js';
import { DeployBeacon } from '../entities/DeployBeacon.js';
import { DeployTether } from '../entities/DeployTether.js';
import { DeployWatersphere } from '../entities/DeployWatersphere.js';
import { DeployPad } from '../entities/DeployPad.js';
import { DeployLoiter } from '../entities/DeployLoiter.js';
import { DeploySpider } from '../entities/DeploySpider.js';
import { DeployJammer } from '../entities/DeployJammer.js';
import { DeployMotion } from '../entities/DeployMotion.js';
import type { Terrain } from '../world/terrain.js';
import { Projectile, type SweepObstacle } from '../projectiles/Projectile.js';
import { Explosion } from '../effects/explosion.js';
import { DeployRockets } from './deployRockets.js';
import { DeployAdopter } from './deployAdopt.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { GRAVITY, BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { WeaponType, REPAIR_ARMOR_MULT } from '../../../shared/weapons.js';
import { aoeDamage } from '../../../shared/combat.js';
import { weaponDef } from '../weapons.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { THROW_RELEASE, THROW_TOTAL } from '../entities/ViewModel.js';
import type { GameContext } from './context.js';
import type { Targetable } from '../entities/balls.js';
import type { TargetCandidate } from './targeting.js';

import { DEPLOY_KINDS, DEPLOY_MAX, type DeployKind } from '../../../shared/deployables.js';
import { RemoteDeployables } from './remoteDeployables.js';
import { DEPLOY_ITEMS, deploySolid, type WaterDome } from '../../../shared/deployItems.js';
import { structureNormalAt, structureTopAt, structureSegHit } from './structureSpecs.js';
import { canThrowPack, packCost, recyclesSeated } from './deployEconomy.js';
import type { StructureCollider } from '../../../shared/ballCollide.js';
export type { DeployKind } from '../../../shared/deployables.js';

// Derived from the shared belt registry - caps/labels can no longer diverge
// from the server authority (drone max 1 vs 2 did once).
const LASH_PAIRS = 8; // max simultaneously snared bodies painted
// One tentacle = two fat tapered segments with a writhing mid-bend.
// Thick at the knot (0.34r), thin at the victim - reads as a lashing
// arm, not a hair-thin line.
const _lashGeo = new THREE.CylinderGeometry(0.1, 0.34, 1, 7);
_lashGeo.translate(0, 0.5, 0);
const _lashMat = new THREE.MeshLambertMaterial({ color: 0x14_0E_18 });
export const DEPLOY_DEFS: { kind: DeployKind; label: string; max: number }[] =
  DEPLOY_KINDS.map((kind): { kind: DeployKind; label: string; max: number; } => ({ kind, label: DEPLOY_ITEMS[kind].label.toUpperCase(), max: DEPLOY_MAX[kind] }));

// Sentry mini-rockets live in deployRockets.ts - a real flying body with
// mild homing, smoke trail, and a blast on contact.
const DEPLOY_SLOPE = 0.75; // normal.y floor - can't plant on cliffs
const POD_SPEED = 30;      // throw velocity along the crosshair
const POD_INHERIT = 0.6;   // fraction of player velocity carried into the toss
const POD_RADIUS = 0.32;
const POD_TTL = 8;         // airtime budget - a pod that never settles fizzles
const NUGGET_LOB = 0.55;   // fraction of pod speed - a nugget lobs, not launches
// Nugget pod visual - identical to the Nugget pickup it lands as
// (entities/Nugget.ts): faceted gold icosa + additive halo. What leaves
// your hand must read as the thing you'll pick back up.
const NUG_POD_GEO = new THREE.IcosahedronGeometry(0.3, 0);
const NUG_POD_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xFF_EE_88).multiplyScalar(EMIT_GAIN) });
const _UP = new THREE.Vector3(0, 1, 0);
const _sn = new THREE.Vector3(); // struct-normal scratch (pad seat)
const _segFrom = new THREE.Vector3(); // pod step segment scratch
const _segHit = new THREE.Vector3();
const _segN = new THREE.Vector3();
const _FAR = new THREE.Vector3(0, -1e5, 0); // dormant-proxy for flying mines
const _repTo = new THREE.Vector3(); // repair-beam ray scratch

interface Pod {
  kind: DeployKind;
  // The item itself IS the thrown body - it unfolds in the air and lands
  // already full-size (same read as a Turretter dropping in). Seated
  // kinds share ONE field; mine/nugget keep their own (bespoke shape).
  item?: PodBody;
  mine?: Mine;
  nugget?: THREE.Mesh; // pure visual - lands as a pickup, not an item
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  ttl: number;
  landed: boolean;
}

type PodBody = DeployTurret | DeployMortar | DeployCg | DeployStation
  | DeployDrone | DeployShield | DeployBeacon | DeployTether | DeployWatersphere | DeployPad | DeployLoiter | DeploySpider
  | DeployJammer | DeployMotion;

/** Seated-kinds registry - one entry per bolted-down kit: ctor + the
 *  adopter slot it lands in. A new kind writes ONE row here instead of
 *  growing a parallel if-chain in every pod path. Mine/nugget aren't
 *  here: their pod lifecycle is bespoke, not the shared seat ceremony. */
const SEATED: Partial<Record<DeployKind, {
  make: (scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) => PodBody;
  adopt: (a: DeployAdopter, b: PodBody, owner?: DeployOwner) => void;
}>> = {
  turret:      { make: (s, t, p) => new DeployTurret(s, t, p),      adopt: (a, b, o) => a.adoptTurret(b as DeployTurret, o) },
  mortar:      { make: (s, t, p) => new DeployMortar(s, t, p),      adopt: (a, b, o) => a.adoptMortar(b as DeployMortar, o) },
  cgturret:    { make: (s, t, p) => new DeployCg(s, t, p),          adopt: (a, b, o) => a.adoptCg(b as DeployCg, o) },
  station:     { make: (s, t, p) => new DeployStation(s, t, p),     adopt: (a, b, o) => a.adoptStation(b as DeployStation, o) },
  drone:       { make: (s, t, p) => new DeployDrone(s, t, p),       adopt: (a, b, o) => a.adoptDrone(b as DeployDrone, o) },
  shield:      { make: (s, t, p) => new DeployShield(s, t, p),      adopt: (a, b, o) => a.adoptShield(b as DeployShield, o) },
  beacon:      { make: (s, t, p) => new DeployBeacon(s, t, p),      adopt: (a, b, o) => a.adoptBeacon(b as DeployBeacon, o) },
  tether:      { make: (s, t, p) => new DeployTether(s, t, p),      adopt: (a, b, o) => a.adoptTether(b as DeployTether, o) },
  watersphere: { make: (s, t, p) => new DeployWatersphere(s, t, p), adopt: (a, b, o) => a.adoptWatersphere(b as DeployWatersphere, o) },
  pad:         { make: (s, t, p) => new DeployPad(s, t, p),         adopt: (a, b, o) => a.adoptPad(b as DeployPad, o) },
  loiter:      { make: (s, t, p) => new DeployLoiter(s, t, p),      adopt: (a, b, o) => a.adoptLoiter(b as DeployLoiter, o) },
  spider:      { make: (s, t, p) => new DeploySpider(s, t, p),      adopt: (a, b, o) => a.adoptSpider(b as DeploySpider, o) },
  jammer:      { make: (s, t, p) => new DeployJammer(s, t, p),      adopt: (a, b, o) => a.adoptJammer(b as DeployJammer, o) },
  motion:      { make: (s, t, p) => new DeployMotion(s, t, p),      adopt: (a, b, o) => a.adoptMotion(b as DeployMotion, o) },
};

export interface Item {
  kind: DeployKind;
  candId: string;
  pos: THREE.Vector3;
  dead: boolean;
  update: (dt: number) => void;
  dispose: () => void;
  hurt: (dmg: number) => void;
  /** Plant owner - per-owner caps and owner-team foe lists for bots.
   *  Undefined = the local player. */
  owner?: string;
  /** Wire id the server assigned (echoed via deploySpawn). The repair
   *  claim carries only this - the server re-derives the heal itself. */
  serverId?: number;
  /** Vitals the repair beam reads - the entity itself for real items,
   *  a plain record for remote-visual ones. */
  v: { health: number; armor: number; maxHealth: number };
  /** Team of the owner when known (bot DeployOwner.team / deploySpawn
   *  wire field) - dome friend-foe checks read it. */
  team?: string;
  /** Dome lattice flare when the field soaks a shell - shield only. */
  flash?: () => void;
  /** Launch fired - the pad's squash snap (padBoing / offline mirror). */
  boing?: () => void;
  /** Munition committed its dive - swoop visual (loiterDive / offline). */
  dive?: (pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }) => void;
  /** The live emitter - lets the aim solve tilt its sky shaft. */
  beacon?: DeployBeacon;
  /** Base-asset lifecycle - deployDown deploys the wreck state (dims
   *  glow, slumps silhouette) without removing the item: it can still
   *  be welded back or respawn on the server clock. */
  downed?: boolean;
  setDown?: (down: boolean) => void;
  /** Offline-authority clocks - server owns both connected. */
  fireCd?: number;
  respawnT?: number;
  /** Base-turret head group + the yaw the offline authority slews it to -
   *  without this the gun sprays at a wall while its head sweeps a patrol
   *  arc ("aiming improperly" is the cosmetic head lying). */
  head?: THREE.Object3D;
  aimYaw?: number;
}


/** A bot that plants - foe lists, anchors, and heals all read through
 *  this instead of the local player singleton. */
export interface DeployOwner {
  id: string;
  team: string;
  pos: THREE.Vector3;
  yaw(): number;
  heal(n: number): void;
  addEnergy(n: number): void;
}

type Foe = { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; playerId?: string;
  /** Bot's move controller - the watersphere dome + tether stamp on it. */
  move?: {
    setWaterDome(d?: { x: number; y: number; z: number; r: number }): void;
    setTether(t?: { x: number; y: number; z: number; r: number }): void;
    readonly tetherSlowNow: number;
  };
  /** Jet-tank access - the tether's break-free zap. */
  drain?: (n: number) => void };

export interface DeployDeps extends GameContext {
  scene: THREE.Scene;    // scene exists before deployables is constructed
  targets: Targetable[]; // shared creature surface
  lazyCombat: () => { hitTargetLocal(t: Targetable, dmg: number, attackerId?: string): boolean; predictLocalShove?(pos: THREE.Vector3, radius: number, force: number, mode: 'push' | 'pull', shooterId?: string, meta?: { pid?: string; wt?: number; pop?: string }): boolean; applyForceToPrey?(pos: THREE.Vector3, radius: number, force: number, mode: 'push' | 'pull'): void } | undefined;
  /** Enemy bots the turret may legally shoot (deployer's team excluded). */
  enemyBots?: () => { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
  /** Damage funnel for bot hits - same authority as a player's bolts. */
  damageBot?: (playerId: string, dmg: number, fromPos: THREE.Vector3) => boolean;
  /** Bots hostile to a given team - a bot-owned turret/mine scans these
   *  instead of the local player's enemies. */
  botFoes?: (team: string) => Foe[];
  /** Offline nugget mint - connected play uses the server's pickup edge,
   *  disconnected drops a local nugget so the pack still works solo. */
  dropNugget?: (pos: THREE.Vector3) => void;
  /** Damage numbers on remote-asset hits - without them a solo gen raid
   *  reads as "nothing is happening" until the wreck. */
  damageNumbers?: { spawn(pos: THREE.Vector3, amount: number, color: string, cam: THREE.Camera): void };
  /** Live vitals bar over a damaged item - same channel weld bars use. */
  showItemBar?: (item: Item, ally: boolean) => void;
  /** Generator power edge - offline only: a downed base generator drops
   *  its team's powered shield panes, revive restores them. */
  basePower?: (team: string, on: boolean) => void;
  /** World camera - the beacon's HUD aim reticle projects through it. */
  camera: THREE.Camera;
}

export class Deployables {
  private items: Item[] = [];
  private pods: Pod[] = [];

  private readonly _zeroVel = new THREE.Vector3();
  private readonly _candList: TargetCandidate[] = [];
  private readonly _enemies: Foe[] = [];
  private readonly _foePool: Foe[] = [];

  constructor(private deps: DeployDeps) {
    this.rockets = new DeployRockets(deps);
    this.remotes = new RemoteDeployables(deps, this.rockets, (): Foe[] => this._enemies);
    this.adopter = new DeployAdopter(deps, this.rockets, this.items, {
      foesFor: (o): Foe[] => this.foesFor(o),
      killItem: (i): void => this.killItem(i),
    });
  }

  /** Pack item is a loadout choice (ESC menu), not a cycle - X throws
   *  whatever you packed. */
  private get selDef(): { kind: DeployKind; label: string; max: number; } {
    return DEPLOY_DEFS.find((d): boolean => d.kind === this.deps.lazyPlayer().packItem) ?? DEPLOY_DEFS[0]!;
  }

  /** Throw the selected pack item - the pod arcs out along the crosshair,
   *  sticks where it lands, then unfolds into the real deployable. */
  deploy(): void {
    const p = this.deps.lazyPlayer();
    if (p.armory.instagib) {return;} // instagib rooms have no pack - the server refuses the claim anyway
    const def = this.selDef;
    if (p.throwLockT > 0) {return;} // mid-throw - the gun hand is busy
    // The gate pays on release and counts pods already in the air (see
    // deployEconomy). Charging on touchdown let a high tosser stack free
    // pods - every airborne throw still saw a full belt and slipped the
    // cost and the kind cap alike.
    const seated = this.items.filter((i): boolean => i.kind === def.kind && !i.dead);
    const airborne = this.pods.reduce((n, pod): number => n + ((pod.kind === def.kind && !pod.landed) ? 1 : 0), 0);
    if (!canThrowPack(p.beltCharges, packCost(def.kind), seated.length, airborne, def.max)) {return;}
    // Belt-throw ceremony: weapon lowers, pod releases at THROW_RELEASE.
    p.throwLockT = THROW_TOTAL;
    this.deps.lazyViewModel?.()?.startThrow();
    // Aim captured at release, not at keypress - the wind-up is long
    // enough to swing the throw across the sky.
    setTimeout((): void => {
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
    // Belt charge is spent at release - the same beat a belt throw pays.
    // Re-check on release: the belt can't have grown since the wind-up
    // gate, but a shot/death in the window must not mint a free pod.
    const pl = this.deps.lazyPlayer();
    const cost = packCost(kind);
    if (pl.beltCharges < cost) {return;}
    pl.beltCharges -= cost;
    // Cap recycle lives here, not at the keypress gate: the oldest seated
    // item of the kind is retired only once the pod actually leaves the
    // hand, so a death/dry abort in the wind-up can't cost you a plant for
    // free. (The gate already refused an all-airborne full cap - reaching
    // here at cap means a seated item exists to recycle.)
    const cap = DEPLOY_DEFS.find((d): boolean => d.kind === kind)?.max ?? 0;
    const seated = this.items.filter((i): boolean => i.kind === kind && !i.dead);
    const airborne = this.pods.reduce((n, pod): number => n + ((pod.kind === kind && !pod.landed) ? 1 : 0), 0);
    if (recyclesSeated(seated.length, airborne, cap)) {seated[0]!.dead = true;}
    const terrain = this.deps.lazyTerrain();
    const pos = p.pos.clone().addScaledVector(dir, 0.8);
    pos.y += 0.4; // release at chest, not feet
    const pod: Pod = {
      kind, pos,
      vel: dir.multiplyScalar(POD_SPEED * (kind === 'nugget' ? NUGGET_LOB : 1)).addScaledVector(p.vel, POD_INHERIT),
      ttl: POD_TTL, landed: false,
    };
    // Thrown nuggets claim at RELEASE with the lob velocity - the server's
    // pickup sim owns the flight and settles the gem to truth. Claiming at
    // landing made a long lob read 'toofar' and the pod vanished (JP's
    // disappearing-nugget report). Planted kinds still claim at seating.
    if (kind === 'nugget' && this.deps.lazyNetworkManager().isConnected()) {
      this.deps.lazyNetworkManager().sendDeploy('nugget', { x: pos.x, y: pos.y, z: pos.z }, { x: pod.vel.x, y: pod.vel.y, z: pod.vel.z });
    }
    // The item is constructed at release - it flies folded and finishes
    // unfolding mid-air, so touchdown lands a full-size sentry/dome.
    if (kind === 'nugget') {
      pod.nugget = new THREE.Mesh(NUG_POD_GEO, NUG_POD_MAT);
      pod.nugget.position.copy(pos);
      pod.nugget.layers.enable(BLOOM_LAYER);
      // Same additive halo the pickup wears - the pickup read at distance.
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(32), color: 0xFF_D5_4A, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(2.2);
      pod.nugget.add(halo);
      this.deps.scene.add(pod.nugget);
    }
    // Server-tracked life: the planted mine lives its wire ttl, not the
    // overlord field's 45s - the server still explodes it either way.
    else if (kind === 'mine') {pod.mine = new Mine(this.deps.scene, terrain, pos, false, DEPLOY_ITEMS.mine.ttlS);}
    else {pod.item = SEATED[kind]!.make(this.deps.scene, terrain, pos);}
    this.pods.push(pod);
    sfx.dash();
  }

  /** Pods fly, unfold, expire — sweep backwards so splices stay cheap. */
  private tickPods(dt: number): void {
    for (let i = this.pods.length - 1; i >= 0; i -= 1) {
      const pod = this.pods[i]!;
      this.updatePod(pod, dt);
      if (pod.ttl <= 0) {
        pod.item?.dispose(this.deps.scene);
        pod.mine?.dispose();
        if (pod.nugget) {this.disposeNuggetPod(pod.nugget);}
        this.pods.splice(i, 1);
      }
    }
  }

  /** Pod flight: gravity arc, the item unfolds mid-air, cliffs deflect it. */
  private updatePod(pod: Pod, dt: number): void {
    const terrain = this.deps.lazyTerrain();
    pod.ttl -= dt;
    pod.vel.y += GRAVITY * dt;
    _segFrom.copy(pod.pos);
    pod.pos.addScaledVector(pod.vel, dt);

    // Structure side/ceiling faces: a pod meeting a wall flank or dome
    // shoulder glances off instead of phasing through. Flat tops skip -
    // the rest check below lands them (same DEPLOY_SLOPE rule as cliffs).
    if (structureSegHit(_segFrom, pod.pos, _segHit, _segN) && _segN.y < DEPLOY_SLOPE) {
      pod.pos.copy(_segHit).addScaledVector(_segN, POD_RADIUS * 0.5);
      const vn = pod.vel.dot(_segN);
      if (vn < 0) {pod.vel.addScaledVector(_segN, -vn * 1.4); pod.vel.multiplyScalar(0.4);}
    }

    // The unfolding kits share one tumble - assemble mid-air, spin, track
    // the pod's fall. Mine/nugget pods differ below.
    const flying = pod.item;
    if (flying) {
      flying.tickUnfold(dt); // assembly completes in the air
      flying.group.rotation.y += dt * 4; // slow tumble reads mass
      flying.pos.copy(pod.pos);
      flying.group.position.copy(pod.pos);
    } else if (pod.nugget) {
      pod.nugget.position.copy(pod.pos);
      pod.nugget.rotation.y += dt * 9;  // tumble - the pickup's own two-axis spin, faster in flight
      pod.nugget.rotation.x += dt * 3.6;
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.update(dt, _FAR); // airborne - nobody to trigger on
    }

    // Collide with the drawn surface, not the smooth field - on convex
    // ground the flat triangles dip under bilinear and a field rest
    // reads as a pod hovering (same gap the Nugget rest fixed).
    // Structure tops count too: only faces at/below the pod (maxTop =
    // pod.pos.y) so flying under a deck doesn't catch the ceiling.
    const groundY = terrain.getRenderedHeight(pod.pos.x, pod.pos.z);
    const structTop = structureTopAt(pod.pos.x, pod.pos.z, pod.pos.y);
    const rest = Math.max(groundY, structTop);
    if (Number.isFinite(rest) && pod.pos.y - POD_RADIUS <= rest) {
      const n = structTop > groundY
        ? (structureNormalAt(pod.pos.x, rest, pod.pos.z, _sn) ?? terrain.getNormal(pod.pos.x, pod.pos.z))
        : terrain.getNormal(pod.pos.x, pod.pos.z);
      if (n.y >= DEPLOY_SLOPE) {
        this.attach(pod, n, rest);
      } else {
        // Cliff face - glance off instead of sticking sideways.
        pod.pos.y = rest + POD_RADIUS;
        const vn = pod.vel.dot(n);
        pod.vel.addScaledVector(n, -vn * 1.4); // reflect, lose energy
        pod.vel.multiplyScalar(0.4);
      }
    }

  }

  /** Touchdown on landable ground - seat the already-unfolded item and
   *  hand it to the live items list. No post-land growth: it dropped in
   *  full-size like a Turretter. */
  private attach(pod: Pod, n: THREE.Vector3, rest?: number): void {
    const terrain = this.deps.lazyTerrain();
    const impact = Math.abs(pod.vel.y);
    pod.landed = true;
    pod.ttl = 0; // consumed - the item lives in this.items now
    const seat = rest ?? terrain.getRenderedHeight(pod.pos.x, pod.pos.z);
    if (Number.isFinite(seat)) {pod.pos.y = seat;}
    // Every bolted-down kit shares the seat: snap to the pod spot, tilt to
    // the face normal, adopt into items. Drone skips the tilt - it lifts
    // off the touchdown spot on its own lift.
    const seated = pod.item;
    if (seated) {
      seated.pos.copy(pod.pos);
      seated.group.position.copy(pod.pos);
      // Drone/watersphere skip the tilt - they orient on their own lift.
      if (pod.kind !== 'drone' && pod.kind !== 'watersphere') {
        const sn = pod.kind === 'pad' ? structureNormalAt(pod.pos.x, pod.pos.y, pod.pos.z, _sn) : null;
        seated.group.quaternion.setFromUnitVectors(_UP, sn ?? n);
      }
      seated.group.scale.setScalar(1); // snap any unfolding tail to done
      seated.unfoldDone();
      SEATED[pod.kind]!.adopt(this.adopter, seated, undefined);
      pod.item = undefined;
      // ownership moved - fizzle cleanup must not dispose it
    } else if (pod.mine) {
      pod.mine.pos.copy(pod.pos);
      pod.mine.seatOn(terrain);
      this.adopter.adoptMine(pod.mine, undefined);
      pod.mine = undefined;
    } else if (pod.nugget) {
      // Nothing seats - the pod IS the payload. Connected, the deploy
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
    // Charge was spent at release (throwPod); this claim is the server's
    // copy of the same spend, not a second one. The nugget already claimed
    // at release - the server sims its flight; don't double-charge.
    if (pod.kind !== 'nugget') {this.deps.lazyNetworkManager().sendDeploy(pod.kind, pod.pos);}
  }

  /** Bot-authored plant - the brain already chose the landing spot, so
   *  the item arrives directly (mirrors the server's handleDeploy, not
   *  the player's thrown pod). Per-owner kind caps apply. */
  plantFor(kind: DeployKind, pos: { x: number; y: number; z: number }, owner: DeployOwner): void {
    const def = DEPLOY_DEFS.find((d): boolean => d.kind === kind);
    if (!def) {return;}
    const live = this.items.filter((i): boolean => i.kind === kind && !i.dead && i.owner === owner.id);
    if (live.length >= def.max) {live[0]!.dead = true;}
    const terrain = this.deps.lazyTerrain();
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    const spec = SEATED[kind];
    if (spec) {
      const item = spec.make(this.deps.scene, terrain, at);
      item.unfoldDone();
      spec.adopt(this.adopter, item, owner);
    } else if (kind === 'nugget') {
      this.deps.dropNugget?.(at);
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
    let n = 0;
    for (const c of this.deps.targets) {
      if (c.dead || c.scoreless) {continue;}
      const e = this._foePool[n] ?? (this._foePool[n] = { pos: null as never, vel: null as never, alive: false });
      e.pos = c.pos; e.vel = c.vel; e.alive = true; e.playerId = undefined;
      this._enemies[((n += 1) - 1)] = e;
    }
    this._enemies.length = n;
    if (owner) {
      for (const b of this.deps.botFoes?.(owner.team) ?? []) {
        if (b.alive) {this._enemies[this._enemies.length] = b;}
      }
    } else {
      for (const b of this.deps.enemyBots?.() ?? []) {
        if (b.alive) {this._enemies[this._enemies.length] = b;}
      }
    }
    return this._enemies;
  }

  // --- Remote deployables -------------------------------------------------
  // Server-owned items other players planted + map-authored base assets.
  // The whole layer lives in remoteDeployables.ts (split when the base
  // visuals grew past the ~900-line file ceiling); these are thin routes.
  private readonly remotes: RemoteDeployables;

  /** deploySpawn echo for a plant we already rendered locally - false
   *  when no live pod exists (replayed intent), caller falls back to a
   *  remote replica so the item isn't a ghost. */
  ackLocal(id: number): boolean {
    return this.remotes.ackLocal(id, this.items);
  }

  remoteSpawn(id: number, spec: { owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }): void {
    if (!Number.isFinite(spec.pos.x + spec.pos.y + spec.pos.z)) {this.deps.logger.warn(`deployable #${id} dropped: non-finite position`); return;}
    this.remotes.spawn(id, spec);
  }

  /** deployHp broadcast - server is the vitals authority; the local
   *  beam's predicted heal gets corrected by this same write. */
  applyDeployHp(id: number, hp: number, armor: number): void {
    this.remotes.applyDeployHp(id, hp, armor);
  }

  remoteDown(id: number): void { this.remotes.down(id); }
  remoteUp(id: number): void { this.remotes.up(id); }

  /** Blast-echo attribution: a triggered mine explodes server-side with
   *  no projectile replica, and its deployDown races the knockback echo -
   *  a live mine within the radius means the blast was expected, not a
   *  prediction miss. */
  mineNear(pos: THREE.Vector3, radius: number): boolean {
    for (const list of [this.items, this.remotes.values()]) {for (const i of list) {
      if (i.dead || i.kind !== 'mine') {continue;}
      if (i.pos.distanceToSquared(pos) < radius * radius) {return true;}
    }}
    return false;
  }

  /** Repair-beam pick: nearest deployed item along the ray, padded -
   *  beam thin but not needle-thin, aim at the body not the feet.
   *  Scans remote items too - without it a welder could only ever reach
   *  their OWN plants, so teammates' gear and base assets couldn't be
   *  repaired by a human at all (server accepted the claims; the ray
   *  just never found a target). */
  repairHit(origin: THREE.Vector3, dir: THREE.Vector3, range: number): { item: Item; t: number } | null {
    // Mirrors the server's repairTarget assist - ~5° cone so the beam
    // visual lands on the same weldable the server picks. Direct
    // capsule hits beat cone candidates.
    const CONE_SIN = 0.0872;
    let bestDirect: Item | null = null;
    let bestDirectT = range;
    let bestCone: Item | null = null;
    let bestConeAng = Infinity;
    let bestConeT = range;
    for (const list of [this.items, this.remotes.values()]) {for (const i of list) {
      if (i.dead) {continue;}
      _repTo.copy(i.pos).sub(origin);
      _repTo.y += 0.7; // body center - turret mast / pad crystal / drone hull
      const proj = _repTo.dot(dir);
      if (proj < 0 || proj > range) {continue;}
      const perp2 = _repTo.lengthSq() - proj * proj;
      const r = 1.1;
      if (perp2 < r * r) {
        const entry = Math.max(proj - Math.sqrt(r * r - perp2), 0);
        if (entry < bestDirectT) { bestDirectT = entry; bestDirect = i; }
        continue;
      }
      const ang = perp2 / (proj * proj);
      if (ang < bestConeAng && ang < CONE_SIN * CONE_SIN) { bestConeAng = ang; bestConeT = proj; bestCone = i; }
    }}
    if (bestDirect) {return { item: bestDirect, t: bestDirectT };}
    return bestCone ? { item: bestCone, t: bestConeT } : null;
  }

  /** Repair beam: heal to maxHealth, overflow banks as armor. The local
   *  write is the offline authority AND the prediction - the server's
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

  /** Nearest damaged item the bot could weld - own gear always, same-team
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

  /** Resolve a brain's repair key to a heal - returns the welded item so
   *  the caller can paint the work, null when the item died mid-walk. */
  weld(key: string, n: number): Item | null {
    const find = (list: Iterable<Item>): Item | null => {
      for (const i of list) {if (this.keyOf(i) === key && !i.dead) {return i;}}
      return null;
    };
    const item = find(this.items) ?? find(this.remotes.values());
    if (!item) {return null;}
    this.healItem(item, n);
    return item;
  }

  // --- Remote welders' beams, pings, shot/boom relays - all inside
  // RemoteDeployables; these keep the public surface stable. -----------

  remoteWeld(srcId: string, serverId: number): void {
    this.remotes.remoteWeld(srcId, serverId);
  }

  remoteRemove(id: number): void {
    this.remotes.remove(id);
    // Own plants are registered by server-id via ackLocal but never join
    // the remotes map - without this their deployGone (server cap-recycle,
    // blast kill) leaves the item alive in items forever: a ghost mesh
    // that also keeps hashing into netEntries against the server roster.
    for (const i of this.items) {
      if (i.serverId === id) {this.killItem(i);}
    }
  }

  /** Roster-reconcile cull for our OWN lane: remoteIds() only covers the
   *  remotes map, so an own plant whose serverId fell off the roster
   *  (cap-recycle while we were away, blast edge lost) would linger
   *  forever - same ghost-mesh + phantom-hash class as deployGone. */
  cullOwn(live: ReadonlySet<number>): void {
    for (const i of this.items) {
      if (i.serverId !== undefined && !live.has(i.serverId)) {this.killItem(i);}
    }
  }

  /** Wire-id → item pairs across BOTH lanes: remote spawns keyed by the
   *  map, plus our own plants once ackLocal stamped their serverId.
   *  Feeds the §4.7 deployable fidelity hash - the server's roster
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

  /** The remote replica map - roster reconcile owns its lifecycle. */
  remoteReplicas(): Map<number, Item> { return this.remotes.replicas(); }

  sensorPing(id: number, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]): void {
    this.remotes.sensorPing(id, team, targets.filter((t): boolean => Number.isFinite(t.x + t.y + t.z)));
  }

  remoteTurretShot(id: number, targetId: string): void { this.remotes.turretShot(id, targetId); }
  remoteSentryShot(id: number, owner: string, x: number, y: number, z: number): void { this.remotes.sentryShot(id, owner, x, y, z); }
  remoteMortarShot(id: number, owner: string, vx: number, vy: number, vz: number): void { this.remotes.mortarShot(id, owner, vx, vy, vz); }
  remoteMineBoom(id: number, pos: { x: number; y: number; z: number }): void { this.remotes.mineBoom(id, pos); }
  padBoing(id: number, pos: { x: number; y: number; z: number }, n: { x: number; y: number; z: number }): void { this.remotes.padBoing(id, pos, n); }
  loiterDive(id: number, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): void { this.remotes.loiterDive(id, pos, vel); }



  // Sentry mini-rockets - see deployRockets.ts.
  private readonly rockets: DeployRockets;
  private readonly adopter: DeployAdopter;

  /** Escort drone - follows the owner's head, plinks enemies with weaker
   *  mini-rockets (60% sentry damage). Same dep: targeting rules. */




  /** Recharge pad - standing in the envelope refills energy fast and
   *  health slowly. Aggro bait by design: it's a dep: candidate, so the
   *  wildlife gnaws it while it works. */


  /** Pod teardown - the geo/mat are module-shared (don't dispose), but
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
      // Fizzle-pop - smaller than the turret's, still tells you it died.
      let tint = 0x55_FF_CC;
  if (item.kind === 'drone') {tint = 0x88_DD_FF;}
  else if (item.kind === 'shield') {tint = 0x66_CC_FF;}
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 0.9, tint));
      sfx.explosionAt(item.pos, false);
    } else if (item.kind === 'turret' || item.kind === 'mortar' || item.kind === 'cgturret') {
      this.deps.world.explosions.push(new Explosion(
        this.deps.scene, item.pos, false, 0, this.deps.lazyTerrain(), 1.4, 0xFF_77_44));
      sfx.explosionAt(item.pos, true);
      screenShake.blast(item.pos, 2, this.deps.lazyPlayer().pos);
    }
  }

  /** Creature contact damage - speciesKit calls this when a committed
   *  hunter is gnawing on a deployable. dmg is per-tick-scaled by caller. */
  hurt(candId: string, dmg: number): void {
    const it = this.items.find((i): boolean => i.candId === candId && !i.dead);
    it?.hurt(dmg);
  }

  /** Live domes as projectile obstacles - the sweep layer treats each
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
      blocks: (p): boolean => remote ? this.remoteShellHostile(i, p.shooterId) : this.localShellHostile(i, p.shooterId),
      onBlocked: (): void | undefined => i.flash?.(),
    };
  }

  /** Locally-simulated domes (yours or a GameBot's, offline): the foe
   *  tables already resolve who's hostile - a bot's dome shields it from
   *  YOUR shells, your dome eats enemy-bot fire. */
  private localShellHostile(i: Item, shooterId: string | null): boolean {
    if (!i.owner) { // the local player's dome - hostile = enemy bots
      return shooterId != null && Boolean(this.deps.enemyBots?.().some((b): boolean => b.playerId === shooterId));
    }
    // Bot-owned dome: the bot's foe list names who's hostile; 'local'
    // covers the player's own shells (shooterId null → 'local').
    const shooter = shooterId ?? 'local';
    return Boolean(this.deps.botFoes?.(i.team ?? '').some((f): boolean => f.playerId === shooter));
  }

  /** Remote (server-owned) domes: teammates pass, everyone else eats the
   *  field - the owner's own shells are replicas elsewhere and never run
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

  /** Offline mirror of RoomDeployables.applyBlast - connected the server
   *  owns item hp and this is dead code; solo the same funnel damages the
   *  map's base assets. Direct inside bodyR pays `damage`, outside pays
   *  the `splash` falloff; sticky pays 2x like the server. */
  blastRemotes(pos: THREE.Vector3, damage: number, splash: number, radius: number, scales?: readonly number[], weapon?: number, shooterId?: string | null): void {
    if (this.deps.lazyNetworkManager().isConnected()) {return;}
    const mult = weapon === WeaponType.Sticky ? 2 : 1;
    const aoe = splash || damage;
    // Both lists - `items` holds locally-adopted plants (mine and the
    // bots'); the server's applyBlast sweeps its whole roster. Own gear
    // never eats own splash - shooter null/undefined is the local player,
    // whose items carry owner === undefined.
    for (const i of [...this.items, ...this.remotes.values()]) {
      if (i.dead || i.downed) {continue;}
      const dist = i.pos.distanceTo(pos);
      if (dist > radius) {continue;}
      // Friendly fire: a teammate's deployable never takes splash from our
      // blast, and the owner's own blast exempts their own gear (null
      // shooter = the local player's plants, all owner-undefined).
      if ((shooterId ?? null) === (i.owner ?? null)) {continue;}
      const { localTeam } = this.deps.world;
      if (i.team !== undefined && localTeam !== undefined && i.team === localTeam && i.owner !== undefined) {continue;}
      const dmg = (dist <= DEPLOY_ITEMS[i.kind].bodyR
        ? damage
        : Math.max(aoeDamage(aoe, dist, radius, scales), Math.round(aoe * 0.5))) * mult;
      if (dmg > 0) {
        i.hurt(dmg);
        this.deps.damageNumbers?.spawn(i.pos, Math.round(dmg), '#ffb066', this.deps.camera);
        this.deps.showItemBar?.(i, i.team !== undefined && i.team === this.deps.world.localTeam);
      }
    }
  }

  /** Nearest hostile emplacement an attacker could shell - mirrors the
   *  server senses' hostileGear scan (enemy-team items in range). */
  hostileGear(team: string | undefined, pos: THREE.Vector3, range: number): { pos: THREE.Vector3; kind: DeployKind } | null {
    let best: Item | null = null; let bd = range * range;
    for (const list of [this.items, this.remotes.values()]) {for (const i of list) {
      if (i.dead || i.downed || !i.team || i.team === team) {continue;}
      const d = i.pos.distanceToSquared(pos);
      if (d < bd) {bd = d; best = i;}
    }}
    return best ? { pos: best.pos, kind: best.kind } : null;
  }

  /** Creature-targeting candidates - deployed items aggro the wildlife. */
  candidates(): TargetCandidate[] {
    this._candList.length = 0;
    for (const i of this.items) {
      if (!i.dead) {this._candList.push({ id: i.candId, pos: i.pos, vel: this._zeroVel, alive: true });}
    }
    return this._candList;
  }

  get count(): number { return this.items.filter((i): boolean => !i.dead).length; }

  /** Solid hulls for the prediction MoveSim - mirrors the server's
   *  RoomDeployables.solidCols (same DEPLOY_ITEMS bodyR/bodyH boxes) so
   *  brushing a turret resolves identically on both ends. The array is
   *  handed to the MovementController once and rewritten in place when
   *  the gear census changes. */
  private readonly solidCols: StructureCollider[] = [];
  private solidSig = -1;
  private solidMv?: { setDynamicCols(c: readonly StructureCollider[]): void };

  private refreshSolidCols(): void {
    this.solidCols.length = 0;
    const push = (i: Item): void => {
      if (i.dead || !deploySolid(i.kind)) {return;}
      const def = DEPLOY_ITEMS[i.kind];
      this.solidCols.push({
        cx: i.pos.x, cy: i.pos.y + def.bodyH / 2, cz: i.pos.z,
        hx: def.bodyR, hy: def.bodyH / 2, hz: def.bodyR, cos: 1, sin: 0,
      });
    };
    for (const i of this.items) {push(i);}
    for (const i of this.remotes.values()) {push(i);}
  }

  update(dt: number): void {
    for (const i of this.items) {if (!i.dead) {i.update(dt);}}
    this.deps.lazyPlayer()?.movement.setTether(this.tetherFor());
    this.deps.lazyPlayer()?.movement.setWaterDome(this.waterDomeFor());
    this.tickBotDomes();
    this.tickBotSnares();
    this.updateLash(dt);

    this.tickPods(dt);
    this.reapDeadItems();
    this.remotes.update(dt);
    this.rockets.update(dt);
    this.updateBeaconAim();
    // Solid-hull sync: a census signature catches every add/remove/death;
    // items never move once planted (drones are excluded by deploySolid).
    let live = 0;
    for (const i of this.items) {if (!i.dead) {live += 1;}}
    const sig = this.items.length * 97 + live * 13 + this.remotes.size * 7;
    if (sig !== this.solidSig) { this.solidSig = sig; this.refreshSolidCols(); }
    const mv = this.deps.lazyPlayer()?.movement as unknown as { setDynamicCols(c: readonly StructureCollider[]): void } | undefined;
    if (mv && mv !== this.solidMv) { mv.setDynamicCols(this.solidCols); this.solidMv = mv; }
    // Same live array for the shell sweep - a planted generator stops a
    // disc on contact instead of letting it phase through to the wall.
    if (Projectile.dynColliders !== this.solidCols) {Projectile.dynColliders = this.solidCols;}
    // Watersphere domes → projectile drag (Projectile.waterDomes, the
    // same by-reference hand-off as dynColliders). EVERY shell wades
    // them - environmental obstacle, no team check, matching the server.
    this.domeScratch.length = 0;
    const wr = DEPLOY_ITEMS.watersphere.waterRadius ?? 0;
    if (wr > 0) {
      for (const i of this.items) {if (!i.dead && i.kind === 'watersphere') {this.domeScratch.push({ x: i.pos.x, y: i.pos.y, z: i.pos.z, r: wr });}}
      for (const i of this.remotes.values()) {if (!i.dead && i.kind === 'watersphere') {this.domeScratch.push({ x: i.pos.x, y: i.pos.y, z: i.pos.z, r: wr });}}
    }
    Projectile.waterDomes = this.domeScratch;
  }

  private readonly domeScratch: WaterDome[] = [];

  // --- Tether lash ------------------------------------------------------
  // Black tendrils from each tether to every enemy caught in its ring. The
  // snare is judged by the sim and the server; this only paints it, from
  // the same ring test the local prediction uses.
  private readonly lashPool: THREE.Mesh[] = []; // 2 segments per pair
  private lashN = 0;
  private lashT = 0;
  private readonly _lashA = new THREE.Vector3();
  private readonly _lashB = new THREE.Vector3();
  private readonly _lashM = new THREE.Vector3();
  private readonly _lashC = new THREE.Vector3();

  /** Stretch one segment mesh from a to b (geo spans +Y 0..1). */
  private lashSeg(a: THREE.Vector3, b: THREE.Vector3, k: number): void {
    if (this.lashN >= LASH_PAIRS * 2) {return;}
    let m = this.lashPool[this.lashN];
    if (!m) {
      m = new THREE.Mesh(_lashGeo, _lashMat);
      m.frustumCulled = false;
      this.deps.scene.add(m);
      this.lashPool.push(m);
    }
    this.lashN += 1;
    m.visible = true;
    m.position.copy(a);
    this._lashM.subVectors(b, a);
    const len = this._lashM.length();
    m.scale.set(1, len, 1);
    // +Y onto the a→b direction.
    m.quaternion.setFromUnitVectors(_UP, this._lashM.normalize());
    m.rotateY(k * 2.1); // twist phase varies the taper seam
  }

  private lashPair(tx: number, ty: number, tz: number, ex: number, ey: number, ez: number): void {
    this._lashA.set(tx, ty + 0.15, tz);
    // Waist height - above the head reads as the nameplate, not a grab.
    this._lashB.set(ex, ey + 0.6, ez);
    // Mid control point: lifted and side-slung, waving - the bend is what
    // reads as a lash instead of a rope.
    const w = Math.sin(this.lashT * 7 + ex * 1.3);
    const w2 = Math.cos(this.lashT * 5.3 + ez * 1.7);
    const mid = this._lashC.lerpVectors(this._lashA, this._lashB, 0.5);
    mid.y += 0.6 + w * 0.35;
    mid.x += w2 * 0.5;
    mid.z += w * 0.5;
    this.lashSeg(this._lashA, mid, ex);
    this.lashSeg(mid, this._lashB, ez);
  }

  private updateLash(dt: number): void {
    this.lashT += dt;
    this.lashN = 0;
    const r2 = DEPLOY_ITEMS.tether.tetherRadius! ** 2;
    const nm = this.deps.lazyNetworkManager();
    const me = nm.getLocalPlayerId();
    const { localTeam } = this.deps.world;
    const lp = this.deps.lazyPlayer();
    for (const list of [this.items, this.remotes.values()]) {
      for (const i of list) {this.lashItem(i, me, localTeam, lp, r2, nm);}
    }
    for (let i = this.lashN; i < this.lashPool.length; i += 1) {
      this.lashPool[i]!.visible = false;
    }
  }

  // One tether's lash candidates: the local player when he's an enemy
  // outside the owner's team, then every enemy roster body in radius.
  private lashItem(i: Item, me: string, localTeam: string | undefined, lp: ReturnType<DeployDeps['lazyPlayer']>, r2: number, nm: ReturnType<DeployDeps['lazyNetworkManager']>): void {
    if (i.kind !== 'tether' || i.dead) {return;}
    if (i.owner !== undefined && i.owner !== me && (!i.team || i.team !== localTeam)) {
      const dx = lp.pos.x - i.pos.x, dz = lp.pos.z - i.pos.z;
      if (dx * dx + dz * dz < r2) {this.lashPair(i.pos.x, i.pos.y, i.pos.z, lp.pos.x, lp.pos.y, lp.pos.z);}
    }
    for (const [pid, rp] of nm.getPlayers()) {
      if (pid === me || pid === i.owner || rp.isDead || (i.team !== undefined && rp.team === i.team)) {continue;}
      const dx = rp.position.x - i.pos.x, dz = rp.position.z - i.pos.z;
      if (dx * dx + dz * dz < r2) {this.lashPair(i.pos.x, i.pos.y, i.pos.z, rp.position.x, rp.position.y, rp.position.z);}
    }
  }

  /** The tether snare the local body stands in - the same rule as the
   *  server's tickTethers (enemy-side, outside the owner) so the local
   *  replay bleeds the same outward speed. Local plants carry owner
   *  undefined; those are ours, never a snare on ourselves. */
  private tetherFor(): { x: number; y: number; z: number; r: number } | undefined {
    const p = this.deps.lazyPlayer();
    if (!p) {return undefined;}
    const me = this.deps.lazyNetworkManager().getLocalPlayerId();
    const { localTeam } = this.deps.world;
    const r = DEPLOY_ITEMS.tether.tetherRadius!;
    for (const list of [this.items, this.remotes.values()]) {
      for (const i of list) {
        if (i.kind !== 'tether' || i.dead || i.owner === undefined || i.owner === me) {continue;}
        if (i.team !== undefined && i.team === localTeam) {continue;}
        const dx = p.pos.x - i.pos.x, dz = p.pos.z - i.pos.z;
        if (dx * dx + dz * dz < r * r) {return { x: i.pos.x, y: i.pos.y, z: i.pos.z, r };}
      }
    }
    return undefined;
  }

  /** The watersphere pocket the local body wades in - the same rule as
   *  the server's tickWatersphere: only a HOSTILE team's dome drags you
   *  (teamless domes are friendly to everyone, matching tickWatersphere). */
  private waterDomeFor(): { x: number; y: number; z: number; r: number } | undefined {
    const p = this.deps.lazyPlayer();
    if (!p) {return undefined;}
    const { localTeam } = this.deps.world;
    const r = DEPLOY_ITEMS.watersphere.waterRadius!;
    for (const list of [this.items, this.remotes.values()]) {
      for (const i of list) {
        if (i.kind !== 'watersphere' || i.dead) {continue;}
        if (i.team === undefined || i.team === localTeam) {continue;}
        const dx = p.pos.x - i.pos.x, dz = p.pos.z - i.pos.z;
        if (dx * dx + dz * dz < r * r) {return { x: i.pos.x, y: i.pos.y, z: i.pos.z, r };}
      }
    }
    return undefined;
  }

  /** Offline half of RoomDeployables.tickWatersphere - solo is the local
   *  sim's own authority, so hostile waterspheres stamp the drag dome on
   *  enemy bot bodies here (server shadows never see offline bots). */
  private readonly domeBots = new Map<string, { setWaterDome(d?: { x: number; y: number; z: number; r: number }): void }>();
  private tickBotDomes(): void {
    const foes = this.deps.botFoes;
    if (!foes) {
      for (const [, mv] of this.domeBots) {mv.setWaterDome(undefined);}
      this.domeBots.clear();
      return;
    }
    const want = this.botDomesWanted(foes, DEPLOY_ITEMS.watersphere.waterRadius!);
    for (const [id, mv] of this.domeBots) {
      if (!want.has(id)) {mv.setWaterDome(undefined); this.domeBots.delete(id);}
    }
    for (const [id, w] of want) {
      w.mv.setWaterDome(w);
      this.domeBots.set(id, w.mv);
    }
  }

  private botDomesWanted(foes: (team: string) => Foe[], r: number):
      Map<string, { x: number; y: number; z: number; r: number; mv: { setWaterDome(d?: { x: number; y: number; z: number; r: number }): void } }> {
    const want = new Map<string, { x: number; y: number; z: number; r: number; mv: { setWaterDome(d?: { x: number; y: number; z: number; r: number }): void } }>();
    for (const i of this.items) {
      if (i.kind !== 'watersphere' || i.dead) {continue;}
      for (const f of foes(i.team ?? '')) {
        if (!f.alive || !f.move || !f.playerId || f.playerId === 'local') {continue;}
        const dx = f.pos.x - i.pos.x, dz = f.pos.z - i.pos.z;
        if (dx * dx + dz * dz < r * r) {want.set(f.playerId, { x: i.pos.x, y: i.pos.y, z: i.pos.z, r, mv: f.move });}
      }
    }
    return want;
  }

  /** Offline mirror of RoomDeployables.tickTethers - snare enemies inside
   *  a tether ring, bleed their outward run, zap their jet tank on the
   *  break-free (slow accumulated while held × tetherZap). */
  private readonly snareBots = new Map<string, { mv: NonNullable<Foe['move']>; drain: NonNullable<Foe['drain']>; hold: number }>();
  private tickBotSnares(): void {
    const foes = this.deps.botFoes;
    if (!foes) {
      for (const [, s] of this.snareBots) {s.mv.setTether(undefined);}
      this.snareBots.clear();
      return;
    }
    const def = DEPLOY_ITEMS.tether;
    const inside = new Set<string>();
    for (const t of this.items) {
      if (t.kind !== 'tether' || t.dead) {continue;}
      for (const f of foes(t.team ?? '')) {
        if (!f.alive || !f.move || !f.playerId || f.playerId === 'local') {continue;}
        const dx = f.pos.x - t.pos.x, dz = f.pos.z - t.pos.z;
        if (dx * dx + dz * dz >= def.tetherRadius! * def.tetherRadius!) {continue;}
        inside.add(f.playerId);
        const s = this.snareBots.get(f.playerId)
          ?? this.snareBots.set(f.playerId, { mv: f.move, drain: f.drain ?? ((): void => {}), hold: 0 }).get(f.playerId)!;
        s.mv.setTether({ x: t.pos.x, y: t.pos.y, z: t.pos.z, r: def.tetherRadius! });
        s.hold = Math.max(s.hold, s.mv.tetherSlowNow);
      }
    }
    for (const [id, s] of this.snareBots) {
      if (inside.has(id)) {continue;}
      s.mv.setTether(undefined);
      this.snareBots.delete(id);
      if (s.hold > 0) {s.drain(def.tetherZap! * s.hold);}
    }
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
    const beacon = this.items.find((i): boolean => i.kind === 'beacon' && !i.dead && i.owner === undefined);
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
      // Flat gun - the reticle IS the beacon; still worth marking.
      beacon.beacon?.setAim(_UP, 40);
      this._beaconAim.set(t.x, t.y + 0.6, t.z);
      hud.updateBeaconAim(this._beaconAim, null, cam, true);
      return;
    }
    const v = cfg.speed, g = Math.abs(GRAVITY);
    const disc = v * v * v * v - g * (g * d * d + 2 * dy * v * v);
    if (disc < 0) {
      // Out of this gun's arc - flag it so the reticle reads "can't reach"
      // instead of lying about a lob that falls short.
      beacon.beacon?.setAim(_UP, 40);
      this._beaconAim.set(t.x, t.y + 0.6, t.z);
      hud.updateBeaconAim(this._beaconAim, null, cam, false);
      return;
    }
    // Two roots to the lob quadratic: the direct low arc and the T2
    // mortar lob over obstacles - both reticles, distinct styles.
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
    // lob reticle projects - the beam tip and the marker coincide on screen.
    this._beaconDir.subVectors(this._beaconLob, t);
    const beamLen = this._beaconDir.length();
    beacon.beacon?.setAim(this._beaconDir, Math.max(beamLen, 4));
    hud.updateBeaconAim(this._beaconAim, this._beaconLob, cam, true);
  }

  // A server-acked local item also sits in byId - drop it or
  // applyDeployHp/remoteWeld keep resolving a corpse until deployGone.
  private reapDeadItems(): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
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
