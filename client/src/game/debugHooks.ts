import * as THREE from 'three';

import type { ChildLogger } from '../core/Logger.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';

export interface DebugHooksDeps {
  scene: THREE.Scene;
  player: Player;
  terrain: Terrain;
  remotePlayers: Map<string, RemotePlayer>;
  logger: ChildLogger;
}

// URL-param debug hooks for headless screenshots:
//   ?yaw=<deg>&pitch=<deg>  — initial look direction
//   ?dummy[&dummypitch=<deg>] — spawn a RemotePlayer ~4m ahead facing us,
//     re-placed in front of the camera every frame so it's always in frame
// Returns the per-frame dummy tick, or null when ?dummy is absent.
export function applyDebugHooks(deps: DebugHooksDeps): ((dt: number) => void) | null {
  const qp = new URLSearchParams(window.location.search);
  const { player } = deps;

  if (qp.has('yaw')) player.yaw = (parseFloat(qp.get('yaw')!) || 0) * Math.PI / 180;
  if (qp.has('pitch')) player.pitch = (parseFloat(qp.get('pitch')!) || 0) * Math.PI / 180;
  if (!qp.has('dummy')) return null;

  const dummy = new RemotePlayer(deps.scene, 'dummy', {
    x: player.pos.x, y: player.pos.y, z: player.pos.z,
  }, deps.terrain);
  deps.remotePlayers.set('dummy', dummy);

  const dummyPitch = (parseFloat(qp.get('dummypitch')!) || 0) * Math.PI / 180;
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.5),
    new THREE.MeshBasicMaterial({ color: 0xff0000 })
  );
  deps.scene.add(marker);
  const scratch = new THREE.Vector3();

  return (_dt: number) => {
    const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
    // Float above eye — never buried in terrain
    dummy.teleportTo(scratch.set(player.pos.x + fx * 4, player.pos.y + 2.0, player.pos.z + fz * 4));
    const m = dummy.model?.object3D;
    deps.logger.debug(`[dummy] pos=${dummy.position.toArray().map(v => v.toFixed(1)).join(',')} modelPos=${m ? m.getWorldPosition(scratch).toArray().map(v => v.toFixed(1)).join(',') : 'none'} visible=${m?.visible} scale=${m?.scale.x.toFixed(3)}`);
    marker.position.copy(dummy.position);
    dummy.rotation.yaw = player.yaw + Math.PI;
    dummy.rotation.pitch = dummyPitch;
  };
}
