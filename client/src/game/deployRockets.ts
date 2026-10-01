// Sentry mini-rockets — the friendly homing bolts deployables lob. A real
// flying body with mild homing, a smoke trail, and a proper little blast
// on contact. Roughly the same DPS as the old hitscan snap, MUCH better
// read. AoE lands on creatures and enemy bots — never on the owner or the
// deployables themselves (not in entities.targets, by design).
import * as THREE from 'three';
import { Explosion } from '../effects/explosion.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { RibbonTrail, DyingRibbons } from '../projectiles/RibbonTrail.js';
import * as sfx from '../core/sfx.js';
import type { DeployDeps } from './deployables.js';

const ROCKET_SPEED = 46;  // m/s cruise
const ROCKET_TURN = 4.5;  // rad/s homing authority — leads, doesn't snap
const ROCKET_TTL = 4;
const ROCKET_FUSE = 1.7;  // proximity detonation distance to the target
const ROCKET_AOE = 3.2;
const ROCKET_DMG = 30;    // center-of-blast damage

const _geoRktBody = new THREE.CylinderGeometry(0.045, 0.065, 0.32, 6);
const _geoRktNose = new THREE.ConeGeometry(0.045, 0.14, 6);
const _rktBodyMat = new THREE.MeshLambertMaterial({ color: 0x5a616b });
const _rktNoseMat = new THREE.MeshBasicMaterial({ color: 0xffcc66 });
const _rktGlowMat = new THREE.SpriteMaterial({
  map: getGlowTexture(), color: 0xff9944, transparent: true,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const _FWD = new THREE.Vector3(0, 0, 1);
// Ribbon colors — hot orange band, white-hot core pair. Same 3-lane recipe
// as live projectiles so a sentry rocket reads as the same class of threat.
const RKTT_COLOR = 0xff9944;
const RKTT_CORE = new THREE.Color(RKTT_COLOR).lerp(new THREE.Color(0xffffff), 0.6).getHex();
const RKTT_W = 0.32;
const RKTT_LIFE = 0.4;

interface Rocket {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } | null;
  ttl: number;
  puff: number;
  dmgScale: number;
  /** Planter id — 'bot:*' for bot deployables, unset for the player's.
   *  Damage numbers only fire on unattributed (mine) hits. */
  owner?: string;
  group: THREE.Group;
  ribbons: RibbonTrail[];
}

export class DeployRockets {
  private rockets: Rocket[] = [];
  /** Stopped ribbons still fade — a detonated missile's streak burns out
   *  in place instead of vanishing frame-perfect with the mesh. */
  private dying = new DyingRibbons();
  private _rktDir = new THREE.Vector3();
  private _rktAim = new THREE.Vector3();
  private _zeroVel = new THREE.Vector3();

  constructor(private deps: DeployDeps) {}

  spawn(muzzle: THREE.Vector3, target: Rocket['target'], dmgScale = 1, owner?: string): void {
    const group = new THREE.Group();
    const body = new THREE.Mesh(_geoRktBody, _rktBodyMat);
    body.rotation.x = Math.PI / 2; // cylinder axis → +Z (flight dir)
    const nose = new THREE.Mesh(_geoRktNose, _rktNoseMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.22;
    const glow = new THREE.Sprite(_rktGlowMat);
    glow.scale.setScalar(0.5);
    glow.position.z = -0.2;
    group.add(body, nose, glow);

    const r: Rocket = {
      pos: muzzle.clone(),
      vel: new THREE.Vector3(),
      target, ttl: ROCKET_TTL, puff: 0, dmgScale, owner, group,
      // Same lane recipe as Projectile visuals: wide tint band + thin hot
      // core pair offset above/below the band's plane.
      ribbons: [
        RibbonTrail.acquire(this.deps.scene, { color: RKTT_COLOR, width: RKTT_W, life: RKTT_LIFE, tag: 'sentry' }),
        RibbonTrail.acquire(this.deps.scene, { color: RKTT_CORE, width: RKTT_W * 0.35, life: RKTT_LIFE * 0.8, vOffset: RKTT_W * 0.07, tag: 'sentry' }),
        RibbonTrail.acquire(this.deps.scene, { color: RKTT_CORE, width: RKTT_W * 0.35, life: RKTT_LIFE * 0.8, vOffset: -RKTT_W * 0.07, tag: 'sentry' }),
      ],
    };
    if (!target) { // fired with no live target — lob up-forward, no homing
      const yaw = this.deps.lazyPlayer().yaw;
      r.vel.set(Math.sin(yaw), 0.3, Math.cos(yaw)).normalize().multiplyScalar(ROCKET_SPEED);
      group.position.copy(muzzle);
      this.deps.scene.add(group);
      this.rockets.push(r);
      return;
    }
    // Initial aim: lead the target by time-of-flight, center-mass.
    this._rktAim.copy(target.pos);
    this._rktAim.y += 0.5;
    this._rktAim.addScaledVector(target.vel, Math.min(1.2, this._rktAim.distanceTo(muzzle) / ROCKET_SPEED));
    this._rktAim.sub(muzzle).normalize();
    r.vel.copy(this._rktAim).multiplyScalar(ROCKET_SPEED);
    group.position.copy(muzzle);
    group.lookAt(this._rktAim.add(muzzle));
    this.deps.scene.add(group);
    this.rockets.push(r);
  }

  update(dt: number): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]!;
      this.step(r, dt);
      if (r.ttl <= 0) {
        this.deps.scene.remove(r.group); // detonate already removed; ttl cut is the safety
        this.dying.fadeAll(r.ribbons);
        this.rockets.splice(i, 1);
        continue;
      }
      for (const t of r.ribbons) { t.push(r.pos, r.vel); t.update(dt); }
    }
    this.dying.update(dt);
  }

  private step(r: Rocket, dt: number): void {
    r.ttl -= dt;
    const terrain = this.deps.lazyTerrain();

    // Homing: steer the velocity vector toward the (lead-compensated)
    // target with a hard turn cap — a missile that curves, not teleports.
    if (r.target?.alive) {
      this._rktAim.copy(r.target.pos);
      this._rktAim.y += 0.5;
      this._rktAim.addScaledVector(r.target.vel, Math.min(1.2, this._rktAim.distanceTo(r.pos) / ROCKET_SPEED));
      this._rktAim.sub(r.pos).normalize();
      this._rktDir.copy(r.vel).normalize();
      const angle = this._rktDir.angleTo(this._rktAim);
      if (angle > 1e-4) {
        this._rktDir.lerp(this._rktAim, Math.min(1, ROCKET_TURN * dt / angle)).normalize();
        r.vel.copy(this._rktDir).multiplyScalar(ROCKET_SPEED);
      }
      if (r.pos.distanceToSquared(r.target.pos) < ROCKET_FUSE * ROCKET_FUSE) {
        this.detonate(r);
        return;
      }
    }

    r.pos.addScaledVector(r.vel, dt);
    r.group.position.copy(r.pos);
    this._rktDir.copy(r.vel).normalize();
    r.group.quaternion.setFromUnitVectors(_FWD, this._rktDir);

    // Motor smoke — one puff every ~50ms sells the burn without a particle
    // system per rocket.
    r.puff -= dt;
    if (r.puff <= 0) {
      r.puff = 0.05;
      this.deps.lazyEffects().spawnMoveDust(r.pos, this._zeroVel, 1, 0.12);
    }

    if (r.ttl <= 0 || r.pos.y < terrain.getHeight(r.pos.x, r.pos.z)) {
      this.detonate(r);
    }
  }

  private detonate(r: Rocket): void {
    r.ttl = 0;
    this.deps.world.explosions.push(new Explosion(
      this.deps.scene, r.pos, false, 0, this.deps.lazyTerrain(), 0.5, 0xffaa44));
    sfx.explosionAt(r.pos, false);
    for (const c of this.deps.targets) {
      if (c.dead || c.scoreless) continue;
      const d = c.pos.distanceTo(r.pos);
      if (d < ROCKET_AOE) {
        const dmg = Math.round(ROCKET_DMG * r.dmgScale * (1 - d / ROCKET_AOE));
        if (dmg > 0) this.deps.lazyCombat()?.hitTargetLocal(c, dmg, r.owner);
      }
    }
    for (const b of this.deps.enemyBots?.() ?? []) {
      if (!b.alive) continue;
      const d = b.pos.distanceTo(r.pos);
      if (d < ROCKET_AOE) {
        const dmg = Math.round(ROCKET_DMG * r.dmgScale * (1 - d / ROCKET_AOE));
        if (dmg > 0) this.deps.damageBot?.(b.playerId, dmg, r.pos);
      }
    }
    this.deps.scene.remove(r.group);
  }

  dispose(): void {
    for (const r of this.rockets) {
      this.deps.scene.remove(r.group);
      for (const t of r.ribbons) t.dispose();
    }
    this.rockets.length = 0;
    this.dying.disposeAll();
  }
}
