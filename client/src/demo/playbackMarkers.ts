// Marker-lane playback — game-state edges that aren't bodies:
//   224 kill — a burst where the victim stood (the body itself already
//       replays through remoteFrames),
//   225 flag — pole + banner proxy; 'carried' rides the carrier's replayed
//       remote body via PlaybackWorld.remotePosAt,
//   226+ pickup — kind-tinted gem; gone removes it.

import * as THREE from 'three';
import type { TargetEvent } from './types.js';
import { TargetEventType, TARGETTYPE_KILL, TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE } from './types.js';
import { Explosion } from '../effects/explosion.js';
import type { PlaybackWorld } from './playbackReconstruction.js';
import { fastForward } from './playbackReconstruction.js';

const PICKUP_COLORS = [0xffcc33, 0xdd4444, 0x44dd66, 0xff8833, 0x44ccff, 0xcc44ff]; // gem/tag/heal/armor/regen/dd
const FLAG_COLORS = [0x55aaff, 0xff8855]; // alpha/beta — matches TEAM_COLORS

function buildFlagProxy(colorIdx: number): THREE.Group {
  const g = new THREE.Group();
  const color = FLAG_COLORS[colorIdx] ?? 0xffcc33;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 4, 6),
    new THREE.MeshBasicMaterial({ color: 0x888888 }));
  pole.position.y = 2;
  const banner = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.2, 4),
    new THREE.MeshBasicMaterial({ color }));
  banner.position.set(0.55, 3.4, 0);
  g.add(pole, banner);
  return g;
}

const pickupGeo = new THREE.IcosahedronGeometry(0.35, 0);

class PlaybackPickup {
  readonly mesh: THREE.Mesh;
  dead = false;
  constructor(scene: THREE.Scene, kindIdx: number, pos: THREE.Vector3) {
    this.mesh = new THREE.Mesh(pickupGeo, new THREE.MeshBasicMaterial({ color: PICKUP_COLORS[kindIdx] ?? 0xffcc33 }));
    this.mesh.position.copy(pos).add(new THREE.Vector3(0, 0.5, 0));
    scene.add(this.mesh);
  }
  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    (this.mesh.material as THREE.Material).dispose();
  }
}

function flagTeamIdx(targetId: number): number {
  return targetId & 0xf; // low nibble of FLAG_DEMO_ID_BASE|teamIdx
}

export function applyPlaybackMarkerEvent(world: PlaybackWorld, ev: TargetEvent): void {
  if (ev.targetType === TARGETTYPE_KILL) {
    // Victim pos + a small red burst — the body gibs ride remoteFrames.
    const pos = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
    world.explosions.push(new Explosion(world.scene, pos, false, 0, world.terrain, 0.8, 0xdd3333));
    return;
  }

  if (ev.targetType === TARGETTYPE_FLAG) {
    const map = world.playbackFlags;
    if (ev.eventType === TargetEventType.Spawned || ev.eventType === TargetEventType.StateChanged || ev.eventType === TargetEventType.Bounce) {
      let flag = map.get(ev.targetId);
      if (!flag) {
        flag = buildFlagProxy(flagTeamIdx(ev.targetId));
        map.set(ev.targetId, flag);
        world.scene.add(flag);
      }
      // health = state code; peakPosX = carrier roster idx + 1. A carried
      // flag parks at its last pos until the per-frame tick re-pins it to
      // the replayed carrier.
      flag.userData.state = ev.health;
      flag.userData.carrierIdx = ev.peakPosX - 1;
      flag.position.set(ev.posX, ev.posY, ev.posZ);
      flag.visible = ev.health !== 1 || !world.remotePosAt?.(flag.userData.carrierIdx);
      return;
    }
    if (ev.eventType === TargetEventType.Destroyed) {
      const flag = map.get(ev.targetId);
      if (flag) {
        world.scene.remove(flag);
        map.delete(ev.targetId);
      }
    }
    return;
  }

  if (ev.targetType >= TARGETTYPE_PICKUP_BASE) {
    const map = world.playbackPickups;
    if (ev.eventType === TargetEventType.Spawned) {
      if (!map.has(ev.targetId)) {
        map.set(ev.targetId, new PlaybackPickup(world.scene, ev.targetType - TARGETTYPE_PICKUP_BASE, new THREE.Vector3(ev.posX, ev.posY, ev.posZ)));
      }
      return;
    }
    if (ev.eventType === TargetEventType.Destroyed) {
      const p = map.get(ev.targetId);
      if (p) {
        p.dispose(world.scene);
        map.delete(ev.targetId);
      }
    }
  }
}

/** Seek path — flags/pickups spawn at their recorded state; kills and
 *  dead flags/pickups skip (they're transient edges). */
export function reconstructSeekMarker(world: PlaybackWorld, ev: TargetEvent, seekTime: number): void {
  if (ev.targetType === TARGETTYPE_KILL) {return;} // past bursts aren't rebuilt
  if (ev.targetType === TARGETTYPE_FLAG) {
    const flag = world.playbackFlags.get(ev.targetId);
    if (ev.eventType === TargetEventType.Destroyed) {
      if (flag) { world.scene.remove(flag); world.playbackFlags.delete(ev.targetId); }
      return;
    }
    applyPlaybackMarkerEvent(world, ev);
    return;
  }
  if (ev.eventType === TargetEventType.Destroyed) {
    const p = world.playbackPickups.get(ev.targetId);
    if (p) { p.dispose(world.scene); world.playbackPickups.delete(ev.targetId); }
    return;
  }
  applyPlaybackMarkerEvent(world, ev);
  // fastForward isn't needed — pickups don't move
  void seekTime;
}

/** Per-frame flag tick — re-pin a carried flag to its replayed carrier. */
export function updatePlaybackFlags(world: PlaybackWorld): void {
  for (const flag of world.playbackFlags.values()) {
    const carrierIdx = flag.userData.carrierIdx as number | undefined;
    if (flag.userData.state === 1 && carrierIdx !== undefined && carrierIdx >= 0) {
      const pos = world.remotePosAt?.(carrierIdx);
      if (pos) {
        flag.position.copy(pos).add(_carryOffset);
        flag.visible = true;
      }
    }
  }
}
const _carryOffset = new THREE.Vector3(0, 1.0, 0);

export function clearPlaybackMarkers(world: PlaybackWorld): void {
  for (const flag of world.playbackFlags.values()) {world.scene.remove(flag);}
  world.playbackFlags.clear();
  for (const p of world.playbackPickups.values()) {p.dispose(world.scene);}
  world.playbackPickups.clear();
}
