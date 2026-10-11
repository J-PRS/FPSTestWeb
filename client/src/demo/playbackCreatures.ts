// Creature playback lane — creature targetEvents (targetType >=
// TARGETTYPE_CREATURE_BASE) replay as lightweight proxies, not the live
// species classes: those pull terrain pools, sim edges and sfx deps a
// 50-year-old clip shouldn't need. A proxy is a ballistic capsule driven
// by the recorded keyframes — spawn/keyframe/die is enough motion for
// the spirit of the shot, and roster snapshots bound the drift.

import * as THREE from 'three';
import {type TargetEvent, TargetEventType, TARGETTYPE_CREATURE_BASE} from './types.js';
import { GRAVITY } from '../../../shared/movement.js';
import type { PlaybackWorld } from './playbackReconstruction.js';
import { fastForward } from './playbackFF.js';
import * as sfxWorld from '../core/sfx/world.js';

// speciesIdx (from DEMO_SPECIES order) -> proxy look. Keys are the file's
// persisted ids, so this table must stay append-only.
const PROXY_SPECS: Record<number, { color: number; r: number; gravity: boolean }> = {
  0: { color: 0x8A_8A_8A, r: 0.5,  gravity: true },  // crawler
  1: { color: 0xCC_99_44, r: 0.4,  gravity: true },  // scarab
  2: { color: 0xDD_44_44, r: 0.45, gravity: false }, // rakk
  3: { color: 0x88_EE_66, r: 0.25, gravity: false }, // gnat
  4: { color: 0x99_66_33, r: 0.6,  gravity: true },  // roller
  5: { color: 0x66_AA_66, r: 0.35, gravity: true },  // snake
  6: { color: 0x77_FF_44, r: 0.35, gravity: true },  // baneling
  7: { color: 0xBB_66_FF, r: 0.7,  gravity: false }, // totem
};

// Geometries/materials are shared module-level per species — same policy as
// shared/ geometries: never disposed, they're a fixed small set.
const geoBySpecies = new Map<number, THREE.CapsuleGeometry>();
const matBySpecies = new Map<number, THREE.MeshLambertMaterial>();

export class PlaybackCreature {
  readonly mesh: THREE.Mesh;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  dead = false;
  private readonly gravity: boolean;

  constructor(scene: THREE.Scene, speciesIdx: number, pos: THREE.Vector3, vel: THREE.Vector3) {
    const spec = PROXY_SPECS[speciesIdx] ?? PROXY_SPECS[0]!;
    let geo = geoBySpecies.get(speciesIdx);
    if (!geo) {
      geo = new THREE.CapsuleGeometry(spec.r, spec.r * 2, 4, 8);
      geoBySpecies.set(speciesIdx, geo);
    }
    let mat = matBySpecies.get(speciesIdx);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color: spec.color });
      matBySpecies.set(speciesIdx, mat);
    }
    this.mesh = new THREE.Mesh(geo, mat);
    this.gravity = spec.gravity;
    this.pos.copy(pos);
    this.vel.copy(vel);
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
  }

  /** Ballistic drift between recorded keyframes — the real hop arcs are
   *  ballistic too, so this stays close to truth at roster cadence. */
  update(dt: number): void {
    if (this.dead) {return;}
    if (this.gravity) {this.vel.y += GRAVITY * dt;}
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    if (this.vel.x * this.vel.x + this.vel.z * this.vel.z > 0.01) {
      this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
  }
}

function speciesIdxOf(ev: TargetEvent): number {
  return ev.targetType - TARGETTYPE_CREATURE_BASE;
}

const PLAYBACK_CREATURE_SNAP_SQ = 2.25; // m² — drift beyond this snaps
const PLAYBACK_CREATURE_SMOOTH = 0.4; // per-keyframe blend under the snap gate

/** Seek path — same contract as reconstructSeekTarget: spawn + fast-forward. */
export function reconstructSeekCreature(world: PlaybackWorld, ev: TargetEvent, deadIds: Set<number>, seekTime: number): void {
  const map = world.playbackCreatureById;
  if (deadIds.has(ev.targetType * 65_536 + ev.targetId)) {return;}

  if (ev.eventType === TargetEventType.Spawned) {
    const c = new PlaybackCreature(world.scene, speciesIdxOf(ev), new THREE.Vector3(ev.posX, ev.posY, ev.posZ), new THREE.Vector3(ev.velX, ev.velY, ev.velZ));
    map.set(ev.targetId, c);
    fastForward(seekTime - ev.timestamp, (): boolean => !c.dead, (s): void => c.update(s));
    return;
  }

  const c = map.get(ev.targetId);
  if (!c || c.dead) {return;}
  c.pos.set(ev.posX, ev.posY, ev.posZ);
  c.vel.set(ev.velX, ev.velY, ev.velZ);
  fastForward(seekTime - ev.timestamp, (): boolean => !c.dead, (s): void => c.update(s));
}

/** Forward playback — events arrive in timestamp order as demo time passes. */
export function applyPlaybackCreatureEvent(world: PlaybackWorld, ev: TargetEvent): void {
  const map = world.playbackCreatureById;
  if (ev.eventType === TargetEventType.Spawned) {
    if (map.has(ev.targetId)) {return;}
    map.set(ev.targetId, new PlaybackCreature(world.scene, speciesIdxOf(ev),
      new THREE.Vector3(ev.posX, ev.posY, ev.posZ), new THREE.Vector3(ev.velX, ev.velY, ev.velZ)));
    return;
  }

  const c = map.get(ev.targetId);
  if (!c || c.dead) {return;}

  if (ev.eventType === TargetEventType.Destroyed) {
    // Generic death cue — species action barks (pounce/zap/skitter) aren't
    // in the recording; a proxy can't invent them.
    sfxWorld.enemyCue(c.pos, 'die');
    c.dead = true;
    c.dispose(world.scene);
    map.delete(ev.targetId);
    return;
  }
  // Bounce/StateChanged/Hit — recorded keyframe. The proxy walks the
  // wire velocity between keyframes; small residual drift blends out
  // (a hard snap every second reads as a teleport pop), large drift
  // means the proxy diverged and snaps.
  const dx = c.pos.x - ev.posX, dy = c.pos.y - ev.posY, dz = c.pos.z - ev.posZ;
  if (dx * dx + dy * dy + dz * dz < PLAYBACK_CREATURE_SNAP_SQ) {
    const a = PLAYBACK_CREATURE_SMOOTH;
    c.pos.x += (ev.posX - c.pos.x) * a;
    c.pos.y += (ev.posY - c.pos.y) * a;
    c.pos.z += (ev.posZ - c.pos.z) * a;
  } else {
    c.pos.set(ev.posX, ev.posY, ev.posZ);
  }
  c.vel.set(ev.velX, ev.velY, ev.velZ);
  c.mesh.position.copy(c.pos);
}

/** Per-frame drift tick — call alongside updateBallsPlayback. */
export function updatePlaybackCreatures(world: PlaybackWorld, dt: number): void {
  for (const c of world.playbackCreatureById.values()) {c.update(dt);}
}

/** Full teardown — ESC-stop path. */
export function clearPlaybackCreatures(world: PlaybackWorld): void {
  for (const c of world.playbackCreatureById.values()) {c.dispose(world.scene);}
  world.playbackCreatureById.clear();
}
