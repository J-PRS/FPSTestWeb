// Deployable playback lane — targetType >= TARGETTYPE_DEPLOY_BASE replays
// as static kind-tinted proxies. Deployables don't move, so the proxy is
// a box that only changes state (down = dimmed, gone = disposed + boom
// for mines); shots are already handled as projectile Fired events.

import * as THREE from 'three';
import type { TargetEvent } from './types.js';
import { TargetEventType, TARGETTYPE_DEPLOY_BASE } from './types.js';
import { Explosion } from '../effects/explosion.js';
import type { PlaybackWorld } from './playbackReconstruction.js';
import { fastForward } from './playbackReconstruction.js';

// kindIdx (DEMO_DEPLOY_KINDS order) -> proxy look. Persisted in files —
// append-only. t = half-extent of the proxy box.
const KIND_SPECS: Record<number, { color: number; w: number; h: number }> = {
  0: { color: 0x555f77, w: 0.5, h: 1.2 },  // turret
  1: { color: 0x664422, w: 0.35, h: 0.25 }, // mine
  2: { color: 0x4477aa, w: 0.8, h: 0.4 },  // station
  3: { color: 0xaaaa44, w: 0.4, h: 0.4 },  // drone
  4: { color: 0x66ccff, w: 1.2, h: 1.6 },  // shield
  5: { color: 0xffcc33, w: 0.3, h: 0.3 },  // nugget
  6: { color: 0x33ffcc, w: 0.3, h: 1.4 },  // beacon
  7: { color: 0xcc7733, w: 1.0, h: 1.4 },  // generator
  8: { color: 0x8899bb, w: 0.6, h: 1.8 },  // sensor
  9: { color: 0x667799, w: 0.7, h: 1.5 },  // sentry
};

const geoByKind = new Map<number, THREE.BoxGeometry>();

export class PlaybackDeployable {
  readonly mesh: THREE.Mesh;
  readonly pos = new THREE.Vector3();
  readonly kindIdx: number;
  dead = false;
  private readonly baseColor: THREE.Color;
  private readonly mat: THREE.MeshLambertMaterial;

  constructor(scene: THREE.Scene, kindIdx: number, pos: THREE.Vector3) {
    const spec = KIND_SPECS[kindIdx] ?? KIND_SPECS[0]!;
    let geo = geoByKind.get(kindIdx);
    if (!geo) {
      geo = new THREE.BoxGeometry(spec.w * 2, spec.h * 2, spec.w * 2);
      geoByKind.set(kindIdx, geo);
    }
    this.baseColor = new THREE.Color(spec.color);
    // Down/up dims the material — per-instance so one downed turret
    // doesn't flicker every turret in the clip.
    this.mat = new THREE.MeshLambertMaterial({ color: spec.color });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.kindIdx = kindIdx;
    this.pos.copy(pos);
    this.mesh.position.copy(pos).add(new THREE.Vector3(0, spec.h, 0));
    scene.add(this.mesh);
  }

  /** Hit events carry hp — 0 is the down state, >0 back up. */
  setHp(hp: number): void {
    this.mat.color.copy(this.baseColor).multiplyScalar(hp > 0 ? 1 : 0.25);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mat.dispose();
  }
}

function kindIdxOf(ev: TargetEvent): number {
  return ev.targetType - TARGETTYPE_DEPLOY_BASE;
}

function boomIfBlast(world: PlaybackWorld, d: PlaybackDeployable, seekTime: number, evTime: number): void {
  // Mines and sentry guns pop on destruction — the VFX radius is cosmetic.
  if (d.kindIdx !== 1 && d.kindIdx !== 9) {return;}
  const exp = new Explosion(world.scene, d.pos, false, 0, world.terrain, 1);
  world.explosions.push(exp);
  const ff = seekTime - evTime;
  if (ff > 0) {fastForward(ff, () => !exp.dead, (s) => exp.update(s));}
}

export function reconstructSeekDeployable(world: PlaybackWorld, ev: TargetEvent, deadIds: Set<number>, seekTime: number): void {
  const map = world.playbackDeployableById;
  if (deadIds.has(ev.targetType * 65_536 + ev.targetId)) {
    if (ev.eventType === TargetEventType.Destroyed) {
      const d = map.get(ev.targetId);
      if (d) {boomIfBlast(world, d, seekTime, ev.timestamp);}
    }
    return;
  }

  if (ev.eventType === TargetEventType.Spawned) {
    map.set(ev.targetId, new PlaybackDeployable(world.scene, kindIdxOf(ev), new THREE.Vector3(ev.posX, ev.posY, ev.posZ)));
    return;
  }

  const d = map.get(ev.targetId);
  if (!d || d.dead) {return;}
  d.pos.set(ev.posX, ev.posY, ev.posZ);
  if (ev.eventType === TargetEventType.Hit) {d.setHp(ev.health);}
}

export function applyPlaybackDeployableEvent(world: PlaybackWorld, ev: TargetEvent): void {
  const map = world.playbackDeployableById;
  if (ev.eventType === TargetEventType.Spawned) {
    if (map.has(ev.targetId)) {return;}
    map.set(ev.targetId, new PlaybackDeployable(world.scene, kindIdxOf(ev), new THREE.Vector3(ev.posX, ev.posY, ev.posZ)));
    return;
  }

  const d = map.get(ev.targetId);
  if (!d || d.dead) {return;}

  if (ev.eventType === TargetEventType.Hit) {
    d.setHp(ev.health);
    return;
  }
  if (ev.eventType === TargetEventType.Destroyed) {
    d.dead = true;
    boomIfBlast(world, d, 0, 0);
    d.dispose(world.scene);
    map.delete(ev.targetId);
  }
}

export function clearPlaybackDeployables(world: PlaybackWorld): void {
  for (const d of world.playbackDeployableById.values()) {d.dispose(world.scene);}
  world.playbackDeployableById.clear();
}
