import * as THREE from 'three';

import type { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';
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
  const qp = urlParams;
  const { player } = deps;

  if (qp.has('yaw')) {player.yaw = (Number.parseFloat(qp.get('yaw')!) || 0) * Math.PI / 180;}
  if (qp.has('pitch')) {player.pitch = (Number.parseFloat(qp.get('pitch')!) || 0) * Math.PI / 180;}
  // ?dummylineup — three real RemotePlayers (light/medium/heavy) pinned
  // side by side in front of the camera for class-body screenshots.
  if (qp.has('dummylineup')) {
    const spots: [id: string, cls: 'light' | 'medium' | 'heavy', off: number][] = [
      ['dummy_l', 'light', -3.2], ['dummy_m', 'medium', 0], ['dummy_h', 'heavy', 3.2],
    ];
    const remotes = spots.map(([id, cls]) => {
      const rp = new RemotePlayer(deps.scene, id, { x: player.pos.x, y: player.pos.y, z: player.pos.z }, deps.terrain);
      rp.setClass(cls);
      deps.remotePlayers.set(id, rp);
      return rp;
    });
    const scratch = new THREE.Vector3();
    return (_dt: number) => {
      const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
      const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
      remotes.forEach((rp, i) => {
        const [, , off] = spots[i]!;
        const x = player.pos.x + fx * 5 + rx * off;
        const z = player.pos.z + fz * 5 + rz * off;
        const y = Math.max(player.pos.y + 0.3, (deps.terrain?.getHeight(x, z) ?? -Infinity) + 0.05);
        rp.teleportTo(scratch.set(x, y, z));
        rp.rotation.yaw = player.yaw + Math.PI;
        rp.tick(_dt);
      });
    };
  }

  if (!qp.has('dummy')) {return null;}

  const dummy = new RemotePlayer(deps.scene, 'dummy', {
    x: player.pos.x, y: player.pos.y, z: player.pos.z,
  }, deps.terrain);
  deps.remotePlayers.set('dummy', dummy);

  const dummyPitch = (Number.parseFloat(qp.get('dummypitch')!) || 0) * Math.PI / 180;
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.5),
    new THREE.MeshBasicMaterial({ color: 0xFF_00_00 })
  );
  deps.scene.add(marker);
  const scratch = new THREE.Vector3();

  return (_dt: number) => {
    const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
    // Float above eye — never buried in terrain
    dummy.teleportTo(scratch.set(player.pos.x + fx * 4, player.pos.y + 2, player.pos.z + fz * 4));
    const m = dummy.model?.object3D;
    deps.logger.debug(`[dummy] pos=${dummy.position.toArray().map(v => v.toFixed(1)).join(',')} modelPos=${m ? m.getWorldPosition(scratch).toArray().map(v => v.toFixed(1)).join(',') : 'none'} visible=${m?.visible} scale=${m?.scale.x.toFixed(3)}`);
    marker.position.copy(dummy.position);
    dummy.rotation.yaw = player.yaw + Math.PI;
    dummy.rotation.pitch = dummyPitch;
  };
}
