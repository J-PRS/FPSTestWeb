// Server-owned pickups — creature kills in team rooms drop a gem anyone on
// a team can touch to bank a point; TDM kills drop a dog tag. Dumb renderers;
// all rules (radius, TTL, team credit) live in RoomPickups server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import type { PickupKind } from '../../../../shared/pickups.js';
import { BELT_MAX } from '../../../../shared/weapons.js';

export function wirePickups(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  const pickupMeshes = new Map<number, { mesh: THREE.Mesh; kind: PickupKind }>();
  const pickupGeos: Record<PickupKind, THREE.BufferGeometry> = {
    gem: new THREE.OctahedronGeometry(0.5),
    // Dog tag — flat plate reads as "kill token", not loot.
    tag: new THREE.BoxGeometry(0.7, 0.14, 0.45),
    heal: new THREE.OctahedronGeometry(0.55),
    armor: new THREE.BoxGeometry(0.8, 0.8, 0.8),
    regen: new THREE.OctahedronGeometry(0.6),
    dd: new THREE.OctahedronGeometry(0.65),
  };
  const pickupMats: Record<PickupKind, THREE.Material> = {
    gem: new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
    tag: new THREE.MeshBasicMaterial({ color: 0xff3355 }),
    heal: new THREE.MeshBasicMaterial({ color: 0x44ff66 }),
    armor: new THREE.MeshBasicMaterial({ color: 0xffaa22 }),
    regen: new THREE.MeshBasicMaterial({ color: 0x66ffee }),
    dd: new THREE.MeshBasicMaterial({ color: 0xff4422 }),
  };
  const addPickup = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind = 'gem') => {
    // A re-spawn for a live id is a blast-knock rest spot — the server's
    // truth lands where the tumble ended; snap the mesh there.
    const live = pickupMeshes.get(id);
    if (live) { live.mesh.position.set(pos.x, pos.y + 0.8, pos.z); return; }
    const m = new THREE.Mesh(pickupGeos[kind], pickupMats[kind]);
    m.position.set(pos.x, pos.y + 0.8, pos.z);
    deps.lazyScene().add(m);
    pickupMeshes.set(id, { mesh: m, kind });
  };
  // Re-export on ctx — gameState needs it for pickups lying down on join.
  ctx.addPickup = addPickup;
  ctx.reconcilePickups = (liveIds) => {
    for (const [id, e] of pickupMeshes) {
      if (liveIds.has(id)) continue;
      deps.lazyScene().remove(e.mesh);
      pickupMeshes.delete(id);
    }
  };

  networkManager.onPickupSpawn = (id, pos, kind) => {
    if (deps.world.playbackMode) return; // live match gems don't belong in the replay
    addPickup(id, pos, kind ?? 'gem');
  };
  networkManager.onPickupGone = (id, by) => {
    if (deps.world.playbackMode) return;
    const e = pickupMeshes.get(id);
    if (e) { deps.lazyScene().remove(e.mesh); pickupMeshes.delete(id); }
    if (by === nm().getLocalPlayerId()) {
      // Nuggets are the belt economy's income — gem or tag, one charge
      // back, capped at the spawn stock. Server owns the truth count.
      if (e?.kind === 'gem' || e?.kind === 'tag') {
        const p = deps.lazyPlayer();
        p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
      }
      if (e?.kind === 'tag') {
        chat.add(null, 'tag confirmed +1');
      } else if (e?.kind === 'gem') {
        // Server-verified collect — grant the same reward local nuggets
        // give offline (heal + jet boost), since MP drops no local loot.
        const p = deps.lazyPlayer();
        p.heal(0.2);
        p.grantJetBoost();
        nm().sendHeal(20);
        chat.add(null, 'nugget banked +1');
      }
      // Powerup kinds apply via the 'buff' message — no local effect here.
    }
  };

  // Server-applied powerup landing on us: mirror the numbers, HUD reads
  // player.armor / player.buffUntil each frame.
  networkManager.onBuff = (msg) => {
    if (deps.world.playbackMode) return;
    const p = deps.lazyPlayer();
    if (msg.health !== undefined) p.health = msg.health;
    if (msg.armor !== undefined) p.armor = msg.armor;
    if (msg.until !== undefined) {
      if (msg.kind === 'regen') p.buffUntil.regen = msg.until;
      if (msg.kind === 'dd') p.buffUntil.dd = msg.until;
    }
    const label = { heal: 'HEAL +50', armor: 'ARMOR +100', regen: 'REGENERATION', dd: 'DOUBLE DAMAGE' }[msg.kind];
    chat.add(null, label);
  };
}
