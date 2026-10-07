// RemoteDeployables — the visual half of OTHER players' and map-authored
// deployables. Pure cosmetics: targeting and damage run on the server,
// this layer only paints what the wire says (deploySpawn echoes, shot
// broadcasts, wreck/revive edges). Split out of deployables.ts when the
// base-asset visuals grew past the ~900-line file ceiling.

import * as THREE from 'three';
import { DeployTurret } from '../entities/DeployTurret.js';
import { DeployShield } from '../entities/DeployShield.js';
import { DeployBeacon } from '../entities/DeployBeacon.js';
import { Explosion } from '../effects/explosion.js';
import { LightningBeam } from '../effects/lightningBeam.js';
import { screenShake } from '../effects/screenShake.js';
import * as sfx from '../core/sfx.js';
import { WeaponType } from '../../../shared/weapons.js';
import { DEPLOY_HP } from '../../../shared/deployables.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { fxPuff } from '../effects/vfx.js';
import type { DeployDeps } from './deployables.js';
import type { Item } from './deployables.js';
import type { DeployRockets } from './deployRockets.js';

type Foe = { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; playerId?: string };

// Mirror of the server HP table for remote-visual items — corrected by
// the first deployHp tick either way.
const DEPLOY_V_CAP = DEPLOY_HP;

const PING_TTL = 3;

export class RemoteDeployables {
  private remote = new Map<number, Item>();
  /** Server id → item for our OWN plants — deploySpawn echoes back to the
   *  owner, letting server-driven events (turretShot) find the visual. */
  private byId = new Map<number, Item>();
  /** The remote replica map — roster reconcile drives lifecycle on it. */
  replicas(): Map<number, Item> { return this.remote; }
  private weldBeams = new Map<string, { beam: LightningBeam; last: number }>();
  private pings: { ring: THREE.Mesh; t: number }[] = [];
  private readonly _weldFrom = new THREE.Vector3();

  constructor(
    private deps: DeployDeps,
    private rockets: DeployRockets,
    /** Remote sentries aim at whatever the shared foe pool currently holds —
     *  cosmetic only (the server picks the real target). */
    private enemies: () => Foe[],
  ) {}

  /** Access for the repair ray / bot weld / dome-obstacle scans that live
   *  in the local layer — they read remote gear the same as planted. */
  values(): IterableIterator<Item> { return this.remote.values(); }
  /** Server-id → item pairs — the §4.7 deployable fidelity hash keys
   *  replicas by their wire id, which only the map holds. */
  entries(): IterableIterator<[number, Item]> { return this.remote.entries(); }
  get(id: number): Item | undefined { return this.byId.get(id); }
  ids(): ReadonlySet<number> { return new Set(this.remote.keys()); }

  /** deploySpawn echo for a plant we already rendered locally. */
  ackLocal(id: number, items: Item[]): void {
    const live = items.filter(i => !i.dead);
    const newest = live[live.length - 1];
    if (newest) { newest.serverId = id; this.byId.set(id, newest); }
  }

  dropById(id: number): void { this.byId.delete(id); }

  spawn(id: number, spec: { owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }): void {
    const { owner, kind, pos, hp, armor, team } = spec;
    if (kind === 'nugget' || this.remote.has(id)) {return;} // mints pickups, never a deploySpawn
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
        update: (dt) => t.update(dt, this.enemies()),
        dispose: () => t.dispose(this.deps.scene),
        v: t, owner,
      };
    } else if (kind === 'beacon') {
      item = this.beaconItem(id, owner, at, hp, armor);
    } else if (kind === 'generator' || kind === 'sensor' || kind === 'sentry') {
      item = this.baseAssetItem(kind, at, hp, armor, team);
      item.owner = owner;
    } else {
      const group = new THREE.Group();
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(kind === 'mine' ? 0.3 : 0.5, 8, 6),
        new THREE.MeshLambertMaterial({ color: kind === 'mine' ? 0x8A5A2A : 0x4a_55_60 }));
      group.add(m);
      group.position.copy(at);
      group.position.y = terrain.getHeight(at.x, at.z);
      this.deps.scene.add(group);
      // Drones chase their owner's shadow server-side — mirror that anchor
      // here or the visual stays parked at the pod's landing spot.
      const update = kind === 'drone'
        ? () => {
            const op = this.deps.lazyNetworkManager().getPlayers().get(owner)?.position;
            if (op) {group.position.set(op.x, op.y + 2.5, op.z);}
          }
        : () => {};
      item = {
        kind, candId: `rdep:${id}`, pos: group.position, dead: false,
        hurt: () => {}, update, dispose: () => this.deps.scene.remove(group),
        v: { health: hp ?? DEPLOY_V_CAP[kind], armor: armor ?? 0, maxHealth: DEPLOY_V_CAP[kind] },
        owner,
      };
    }
    item.serverId = id;
    item.team = team;
    this.remote.set(id, item);
    this.byId.set(id, item);
  }

  /** Remote beacon — same DeployBeacon visual as a local plant; the item
   *  is a server-lifetime proxy, so hurt is a no-op (deployGone kills it). */
  private beaconItem(_id: number, owner: string, at: THREE.Vector3, hp?: number, armor?: number): Item {
    const b = new DeployBeacon(this.deps.scene, this.deps.lazyTerrain(), at);
    b.unfoldDone();
    if (hp !== undefined) { b.health = hp; b.armor = armor ?? 0; }
    return {
      kind: 'beacon', candId: `rdep:${_id}`, pos: b.pos, dead: false,
      hurt: () => {},
      update: (dt) => b.update(dt),
      dispose: () => b.dispose(this.deps.scene),
      v: b, owner,
    };
  }

  /** Map-authored base asset — generator block, sensor mast, or base
   *  sentry, built from kit primitives so a down state can kill the glow
   *  without tearing the mesh. Wreck dims the emissive, slumps the hull,
   *  and breathes a thin smoke wisp until it's welded or respawns. The
   *  deck plinth stays lit either way — the socket reads even dead. */
  private baseAssetItem(kind: 'generator' | 'sensor' | 'sentry', at: THREE.Vector3, hp?: number, armor?: number, team?: string): Item {
    const teamColor = team === 'alpha' ? 0x55AAFF : team === 'bravo' ? 0xff_88_55 : 0x99AABB;
    const group = new THREE.Group();
    const glowMat = new THREE.MeshBasicMaterial({ color: teamColor });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x39424E });
    const hullMat = new THREE.MeshLambertMaterial({ color: 0x55606E });
    // Mounting plinth — a low deck plate with team-lit trim that stays
    // intact when the asset dies, so the site reads as a socket even
    // while its hulk is dark. Sits below the slumped wreck.
    const plinthR = kind === 'generator' ? 3.4 : kind === 'sentry' ? 2.2 : 1.6;
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(plinthR, plinthR + 0.4, 0.35, 8), darkMat);
    plinth.position.y = 0.18;
    group.add(plinth);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(plinthR - 0.05, 0.09, 6, 24), glowMat);
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 0.36;
    group.add(trim);
    // Sentry's rotating head — declared up here so update() can idle-scan
    // it; stays a child of group so wreck slump still tilts the whole rig.
    const head = new THREE.Group();
    if (kind === 'generator') {
      const hull = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.4, 4.6), hullMat);
      hull.position.y = 1.7;
      group.add(hull);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 2.6, 10), glowMat);
      core.position.y = 1.8;
      group.add(core);
      for (const sx of [-1, 1]) {for (const sz of [-1, 1]) {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.4, 0.7), darkMat);
        pylon.position.set(sx * 2.1, 2.2, sz * 2.1);
        group.add(pylon);
      }}
    } else if (kind === 'sentry') {
      // Base defense gun — must read at 200m atop its pillar: tapered
      // armored collar, slab mantlet with a hood brow, twin heavy
      // barrels with muzzle sleeves, rear ammo drum. ~2x the thrown
      // pod-sentry's mass so "emplaced base gun" and "field turret"
      // never blur in silhouette.
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.5, 1.2, 8), darkMat);
      collar.position.y = 0.95;
      group.add(collar);
      // Team-lit socket ring where the mount meets the plinth — reads
      // "this is powered" before the gun itself resolves.
      const collarRing = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.12, 6, 24), glowMat);
      collarRing.rotation.x = Math.PI / 2;
      collarRing.position.y = 1.55;
      group.add(collarRing);
      head.position.y = 2.4;
      const mantlet = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.7, 2.4), hullMat);
      head.add(mantlet);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.45, 2.6), darkMat);
      brow.position.y = 1.05;
      head.add(brow);
      for (const sx of [-0.6, 0.6]) {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 3.6, 8), darkMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(sx, 0.15, 2.4);
        head.add(barrel);
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.7, 8), hullMat);
        sleeve.rotation.x = Math.PI / 2;
        sleeve.position.set(sx, 0.15, 3.9);
        head.add(sleeve);
      }
      const optic = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), glowMat);
      optic.position.set(0, 0.6, 1.3);
      head.add(optic);
      const ammo = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.5), darkMat);
      ammo.position.set(0, 0.1, -1.6);
      head.add(ammo);
      group.add(head);
    } else {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 9, 8), darkMat);
      mast.position.y = 4.5;
      group.add(mast);
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.25, 12), hullMat);
      dish.rotation.z = Math.PI / 2;
      dish.position.y = 8.4;
      group.add(dish);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), glowMat);
      tip.position.y = 9.6;
      group.add(tip);
    }
    group.position.copy(at);
    // Tower-mounted assets author a real y — terrain is a floor for the
    // buried-y convention, not a ceiling on rooftops.
    group.position.y = Math.max(at.y, this.deps.lazyTerrain().getHeight(at.x, at.z));
    this.deps.scene.add(group);
    const spin = kind === 'sensor' ? group.children[3]! : null;
    const isSentry = kind === 'sentry';
    let scanT = Math.random() * 6;
    // Joined mid-wreck: snapshot hp 0 → spawn it already dark.
    const wrecked = hp !== undefined && hp <= 0;
    let downed = wrecked;
    let smokeT = 0;
    if (wrecked) { glowMat.color.setHex(0x181C22); group.rotation.z = 0.07; group.scale.y = 0.82; }
    const item: Item = {
      kind, candId: `rdep:${at.x.toFixed(0)},${at.z.toFixed(0)}`, pos: group.position, dead: false,
      hurt: () => {},
      update: (dt) => {
        if (spin) {spin.rotation.y += dt * 0.8;}
        // Sentry watch sweep — a live base gun scans its arc; a downed
        // one freezes mid-bearing, which doubles as a dead giveaway.
        if (isSentry && !downed) {
          scanT += dt;
          head.rotation.y = Math.sin(scanT * 0.5) * 0.7;
        }
        // Burnout wisp — a downed asset smokes gently so the site reads
        // "weld me" from across the field, not just "darker box".
        if (downed) {
          smokeT -= dt;
          if (smokeT <= 0) {
            smokeT = 0.35;
            fxPuff(group.position, {
              count: 2, pos: [0.5, 2.6, 0.5],
              velMin: [-0.2, 0.9, -0.2], velMax: [0.3, 1.9, 0.3],
              lifeMin: 1.6, lifeMax: 2.8, sizeScale: 1.7,
              colA: [0.1, 0.1, 0.11], colB: [0.26, 0.25, 0.24],
              gravity: false,
            });
          }
        }
      },
      dispose: () => this.deps.scene.remove(group),
      v: { health: hp ?? DEPLOY_V_CAP[kind], armor: armor ?? 0, maxHealth: DEPLOY_V_CAP[kind] },
      downed,
      setDown: (down) => {
        downed = down;
        glowMat.color.setHex(down ? 0x18_1c_22 : teamColor);
        if (down) { group.rotation.z = 0.07; group.scale.y = 0.82; }
        else { group.rotation.z = 0; group.scale.y = 1; }
      },
    };
    return item;
  }

  /** deployHp broadcast — server is the vitals authority; the local
   *  beam's predicted heal gets corrected by this same write. */
  applyDeployHp(id: number, hp: number, armor: number): void {
    const it = this.byId.get(id);
    if (it) { it.v.health = hp; it.v.armor = armor; }
  }

  /** deployDown — a base asset got shelled into a hulk. It stays in the
   *  world (weldable, respawning), just dark. Same blast read as a plant
   *  dying — a generator going down is the loudest event on the map. */
  down(id: number): void {
    const it = this.byId.get(id);
    if (!it) {return;}
    it.downed = true;
    it.setDown?.(true);
    it.v.health = 0;
    this.deps.world.explosions.push(new Explosion(
      this.deps.scene, it.pos, false, 0, this.deps.lazyTerrain(), 1.6, 0xFFAA55));
    sfx.explosionAt(it.pos, true);
    screenShake.blast(it.pos, 3, this.deps.lazyPlayer().pos);
  }

  up(id: number): void {
    const it = this.byId.get(id);
    if (!it) {return;}
    it.downed = false;
    it.setDown?.(false);
  }

  /** One weld tick from a remote player/bot — refreshes that welder's
   *  beam from their eye (remote positions are eye height) to the item. */
  remoteWeld(srcId: string, serverId: number): void {
    const item = this.byId.get(serverId);
    const rp = this.deps.world.remotePlayers.get(srcId);
    if (!item || item.dead || !rp) {return;}
    let w = this.weldBeams.get(srcId);
    if (!w) {
      w = {
        beam: new LightningBeam(this.deps.scene, {
          glow: 0x1FBB66, core: 0xDCFFE8, chain: 0x7DFFB8, hit: 0xAAFFCC, sparkTop: 0x66_ff_aa,
        }),
        last: 0,
      };
      this.weldBeams.set(srcId, w);
    }
    w.last = performance.now();
    this._weldFrom.copy(rp.position);
    w.beam.fire(this._weldFrom, item.pos, this.deps.lazyPlayer().pos, true, true);
  }

  remove(id: number): void {
    this.byId.delete(id);
    const item = this.remote.get(id);
    if (!item) {return;}
    this.remote.delete(id);
    item.dispose();
  }

  // --- Sensor pings -------------------------------------------------------
  // A base mast relays hostiles inside its radius to the owning team.
  // The client draws an expanding contact ring at each reported body —
  // pure intel, same read as a motion-tracker blip.

  /** sensorPing — only OUR team's mast intel is drawn; enemy sweeps are
   *  broadcast openly but painting them would hand their radar to us. */
  sensorPing(_id: number, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]): void {
    const nm = this.deps.lazyNetworkManager();
    const mine = nm.getPlayers().get(nm.getLocalPlayerId() ?? '')?.team;
    if (team && mine && team !== mine) {return;}
    for (const t of targets) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1, 24),
        new THREE.MeshBasicMaterial({ color: 0xFF5544, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(t.x, t.y + 0.15, t.z);
      this.deps.scene.add(ring);
      this.pings.push({ ring, t: PING_TTL });
    }
  }

  /** Server announced a sentry shot — paint the rocket it represents so
   *  the defender sees the incoming, not just the health loss. */
  turretShot(id: number, targetId: string): void {
    const item = this.byId.get(id);
    if (!item) {return;}
    const nm = this.deps.lazyNetworkManager();
    const t = nm.getPlayers().get(targetId);
    const tp = targetId === nm.getLocalPlayerId()
      ? this.deps.lazyPlayer().pos
      : t?.position;
    if (!tp) {return;}
    // Positions are feet — home at capsule center or the rocket slams
    // terrain at the target's toes (the damage lands regardless, so the
    // visual was reading as "sentry shoots the ground").
    const target = { pos: new THREE.Vector3(tp.x, tp.y + 1, tp.z), vel: new THREE.Vector3(), alive: true };
    this.rockets.spawn(item.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), target, 1, item.owner);
    sfx.shotAt(item.pos, WeaponType.RocketLauncher);
  }

  /** Base sentry bolt — the blast lands at the wire aim point, not on a
   *  tracked body: a still target proxy makes the rocket fly the same
   *  straight line the server flew. */
  sentryShot(id: number, owner: string, x: number, y: number, z: number): void {
    const item = this.byId.get(id);
    if (!item) {return;}
    const target = { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), alive: true };
    this.rockets.spawn(item.pos.clone().add(new THREE.Vector3(0, 2.2, 0)), target, 1, owner);
    sfx.shotAt(item.pos, WeaponType.RocketLauncher);
  }

  /** Server tripped a mine — paint the blast at the reported position.
   *  remoteRemove also arrives (deployGone); either order resolves since
   *  the item may already be gone locally. */
  mineBoom(_id: number, pos: { x: number; y: number; z: number }): void {
    sfx.explosionAt(new THREE.Vector3(pos.x, pos.y, pos.z), true);
  }

  update(dt: number): void {
    for (const i of this.remote.values()) {i.update(dt);}
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i]!;
      p.t -= dt;
      const k = 1 - p.t / PING_TTL;
      p.ring.scale.setScalar(1 + k * 6);
      (p.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      if (p.t <= 0) { this.deps.scene.remove(p.ring); this.pings.splice(i, 1); }
    }
    // Weld beams expire a quarter-second after the last relayed tick —
    // deployHp cadence is ~100ms, so a real weld never gaps long enough
    // to flicker while a stopped one clears fast.
    const nowMs = performance.now();
    for (const [id, w] of this.weldBeams) {
      w.beam.update(dt);
      if (nowMs - w.last > 250) { w.beam.dispose(); this.weldBeams.delete(id); }
    }
  }

  dispose(): void {
    for (const p of this.pings) {this.deps.scene.remove(p.ring);}
    this.pings.length = 0;
    for (const i of this.remote.values()) {i.dispose();}
    this.remote.clear();
    for (const w of this.weldBeams.values()) {w.beam.dispose();}
    this.weldBeams.clear();
  }
}
