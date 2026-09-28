// Server-owned pickups — creature kills in team rooms drop a gem anyone on
// a team can touch to bank a point; TDM kills drop a dog tag. Dumb renderers;
// all rules (radius, TTL, team credit) live in RoomPickups server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';

export function wirePickups(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  const pickupMeshes = new Map<number, { mesh: THREE.Mesh; kind: 'gem' | 'tag' }>();
  const pickupGeos = {
    gem: new THREE.OctahedronGeometry(0.5),
    // Dog tag — flat plate reads as "kill token", not loot.
    tag: new THREE.BoxGeometry(0.7, 0.14, 0.45),
  };
  const pickupMats = {
    gem: new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
    tag: new THREE.MeshBasicMaterial({ color: 0xff3355 }),
  };
  const addPickup = (id: number, pos: { x: number; y: number; z: number }, kind: 'gem' | 'tag' = 'gem') => {
    if (pickupMeshes.has(id)) return;
    const m = new THREE.Mesh(pickupGeos[kind], pickupMats[kind]);
    m.position.set(pos.x, pos.y + 0.8, pos.z);
    deps.lazyScene().add(m);
    pickupMeshes.set(id, { mesh: m, kind });
  };
  // Re-export on ctx — gameState needs it for pickups lying down on join.
  ctx.addPickup = addPickup;

  networkManager.onPickupSpawn = (id, pos, kind) => {
    if (deps.world.playbackMode) return; // live match gems don't belong in the replay
    addPickup(id, pos, kind ?? 'gem');
  };
  networkManager.onPickupGone = (id, by) => {
    if (deps.world.playbackMode) return;
    const e = pickupMeshes.get(id);
    if (e) { deps.lazyScene().remove(e.mesh); pickupMeshes.delete(id); }
    if (by === nm().getLocalPlayerId()) {
      if (e?.kind === 'tag') {
        chat.add(null, 'tag confirmed +1');
      } else {
        // Server-verified collect — grant the same reward local nuggets
        // give offline (heal + jet boost), since MP drops no local loot.
        const p = deps.lazyPlayer();
        p.heal(0.2);
        p.grantJetBoost();
        nm().sendHeal(20);
        chat.add(null, 'nugget banked +1');
      }
    }
  };
}
