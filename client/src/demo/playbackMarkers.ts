// Marker-lane playback — game-state edges that aren't bodies:

//   224 kill — a burst where the victim stood (the body itself already

//       replays through remoteFrames),

//   225 flag — pole + banner proxy; 'carried' rides the carrier's replayed

//       remote body via PlaybackWorld.remotePosAt,

//   226+ pickup — kind-tinted gem; gone removes it.



import * as THREE from 'three';

import {type TargetEvent, TargetEventType, TARGETTYPE_KILL, TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE, TARGETTYPE_NODE} from './types.js';

import { Explosion } from '../effects/explosion.js';

import type { PlaybackWorld } from './playbackReconstruction.js';

import * as sfxUtil from '../core/sfx/util.js';

import * as sfxPlayer from '../core/sfx/player.js';

const _carryOffset = new THREE.Vector3(0, 1, 0);



const PICKUP_COLORS = [0xFF_CC_33, 0xDD_44_44, 0x44_DD_66, 0xFF_88_33, 0x44_CC_FF, 0xCC_44_FF]; // gem/tag/heal/armor/regen/dd

const FLAG_COLORS = [0x55_AA_FF, 0xFF_88_55]; // alpha/beta — matches TEAM_COLORS



function buildFlagProxy(colorIdx: number): THREE.Group {

  const g = new THREE.Group();

  const color = FLAG_COLORS[colorIdx] ?? 0xFF_CC_33;

  const pole = new THREE.Mesh(

    new THREE.CylinderGeometry(0.06, 0.08, 4, 6),

    new THREE.MeshBasicMaterial({ color: 0x88_88_88 }));

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

    this.mesh = new THREE.Mesh(pickupGeo, new THREE.MeshBasicMaterial({ color: PICKUP_COLORS[kindIdx] ?? 0xFF_CC_33 }));

    this.mesh.position.copy(pos).add(new THREE.Vector3(0, 0.5, 0));

    scene.add(this.mesh);

  }

  dispose(scene: THREE.Scene): void {

    scene.remove(this.mesh);

    (this.mesh.material as THREE.Material).dispose();

  }

}



function flagTeamIdx(targetId: number): number {

  return targetId & 0xF; // low nibble of FLAG_DEMO_ID_BASE|teamIdx

}



export function applyPlaybackMarkerEvent(world: PlaybackWorld, ev: TargetEvent, audible = false): void {

  if (ev.targetType === TARGETTYPE_KILL) {

    // Victim pos + a small red burst — the body gibs ride remoteFrames.

    const pos = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);

    world.explosions.push(new Explosion(world.scene, pos, false, 0, world.terrain, 0.8, 0xDD_33_33));

    // Live kills cue a death bark at the body — playback's version.

    if (audible) {sfxUtil.at(pos, 'robot_die', 0.9);}

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

      if (audible) {

        // Flag cues are global in live play, but a clip is about THE shot —

        // a grab on the far side of the map is mix noise. Earshot only.

        const prev = flag.userData.state as number | undefined;

        const near = world.camera.position.distanceToSquared(flag.position) < 80 * 80;

        if (near && ev.health !== prev) {

          if (ev.health === 1) {sfxPlayer.flagCue('taken', false);}

          else if (ev.health === 2) {sfxPlayer.flagCue('dropped', false);}

          else if (ev.health === 0 && prev === 2) {sfxPlayer.flagCue('returned', false);}

        }

      }

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



  if (ev.targetType === TARGETTYPE_NODE) {
    // Marker state arrives packed — decode straight into the mirror
    // map; the HUD diamond tick reads world.nodeMarkers.
    if (ev.eventType === TargetEventType.Destroyed) {
      world.playbackNodes.delete(ev.targetId & 0xF_FF);
      return;
    }
    world.playbackNodes.set(ev.targetId & 0xF_FF, {
      x: ev.posX, y: ev.posY, z: ev.posZ,
      meta: ev.peakPosX, gx: ev.peakPosY, gz: ev.peakPosZ, hp: ev.health,
    });
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

      if (!p) {return;}

      // Grabbed — gem/tag ping like a pickup, the rest chime like a

      // powerup, matching the live pickupGrab/powerup split.

      if (audible) {

        sfxUtil.at(p.mesh.position, ev.targetType - TARGETTYPE_PICKUP_BASE <= 1 ? 'pickup' : 'powerup');

      }

      p.dispose(world.scene);

      map.delete(ev.targetId);

    }

  }

}



/** Seek path — flags/pickups spawn at their recorded state; kills and

 *  dead flags/pickups skip (they're transient edges). */

export function reconstructSeekMarker(world: PlaybackWorld, ev: TargetEvent, _seekTime: number): void {

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

}



/** Per-frame flag tick — re-pin a carried flag to its replayed carrier. */

export function updatePlaybackFlags(world: PlaybackWorld): void {

  for (const flag of world.playbackFlags.values()) {

    const carrierIdx = flag.userData.carrierIdx as number | undefined;

    if (flag.userData.state !== 1 || carrierIdx === undefined || carrierIdx < 0) {continue;}

    const pos = world.remotePosAt?.(carrierIdx);

    if (!pos) {continue;}

    flag.position.copy(pos).add(_carryOffset);

    flag.visible = true;

  }

}



export function clearPlaybackMarkers(world: PlaybackWorld): void {

  for (const flag of world.playbackFlags.values()) {world.scene.remove(flag);}

  world.playbackFlags.clear();

  for (const p of world.playbackPickups.values()) {p.dispose(world.scene);}

  world.playbackPickups.clear();

}

