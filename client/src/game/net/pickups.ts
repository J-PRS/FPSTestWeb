// Server-owned pickups — creature kills in team rooms drop a gem anyone on
// a team can touch to bank a point; TDM kills drop a dog tag. Dumb renderers;
// all rules (radius, TTL, team credit) live in RoomPickups server-side.

import type { NetCtx } from './ctx.js';
import type { PickupKind } from '../../../../shared/pickups.js';
import { BELT_MAX } from '../../../../shared/weapons.js';
import { pickupBurst, PICKUP_ACCENT, pickupParts } from '../../entities/PickupModel.js';
import { Nugget } from '../../entities/Nugget.js';
import * as THREE from 'three';
import * as sfxPlayer from '../../core/sfx/player.js';

const _zeroVel = new THREE.Vector3();

export function wirePickups(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  // Every pickup renders as the same Nugget class offline drops use —
  // physically tumbling, blast-scatterable; the kind reads purely by
  // tint (heal green, armor orange, tag red...). They live in the shared
  // `nuggets` array so blastForce scatters them identically and
  // updateNuggets ticks/disposes them; the server only owns spawn,
  // collect edges, and rest-spot truth.
  const pickupMeshes = new Map<number, { nugget: Nugget; kind: PickupKind }>();
  // Shared view for the §4.7 pickup fidelity hash — stateDebug reads the
  // same map; kind is all it needs (id is the key).
  deps.world.netPickups = pickupMeshes as Map<number, { kind: PickupKind }>;
  const addPickup = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind = 'gem') => {
    deps.lazyDemoManager?.()?.recordPickupSpawned(id, kind, pos);
    // A re-spawn for a live id is a blast-knock rest spot — the server's
    // truth lands where the tumble ended; converge the replica there.
    const live = pickupMeshes.get(id);
    if (live) { live.nugget.serverRest(pos); return; }
    const nugget = new Nugget(
      deps.lazyScene(),
      new THREE.Vector3(pos.x, pos.y, pos.z),
      _zeroVel,
      PICKUP_ACCENT[kind],
      pickupParts(kind),
    );
    nugget.serverOwned = true;
    deps.entities().nuggets.push(nugget);
    pickupMeshes.set(id, { nugget, kind });
  };
  // Re-export on ctx — gameState needs it for pickups lying down on join.
  ctx.addPickup = addPickup;
  ctx.reconcilePickups = (liveIds) => {
    for (const [id, e] of pickupMeshes) {
      if (liveIds.has(id)) {continue;}
      deps.lazyDemoManager?.()?.recordPickupGone(id);
      e.nugget.serverCollect(); // fade; updateNuggets reaps
      pickupMeshes.delete(id);
    }
  };

  networkManager.onPickupSpawn = (id, pos, kind) => {
    if (deps.world.playbackMode) {return;} // live match gems don't belong in the replay
    addPickup(id, pos, kind ?? 'gem');
  };
  networkManager.onPickupGone = (id, by) => {
    if (deps.world.playbackMode) {return;}
    const e = pickupMeshes.get(id);
    deps.lazyDemoManager?.()?.recordPickupGone(id);
    if (e) {
      pickupBurst(e.nugget.pos.clone(), e.kind);
      e.nugget.serverCollect();
      pickupMeshes.delete(id);
    }
    if (by === nm().getLocalPlayerId()) {
      // Nuggets are the belt economy's income — gem or tag, one charge
      // back, capped at the spawn stock. Server owns the truth count.
      if (e?.kind === 'gem' || e?.kind === 'tag') {
        const p = deps.lazyPlayer();
        p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
      }
      if (e?.kind === 'tag') {
        sfxPlayer.powerup('tag');
        chat.add(null, 'tag confirmed +1');
      } else if (e?.kind === 'gem') {
        // Server-verified collect — grant the same reward local nuggets
        // give offline (heal + jet boost), since MP drops no local loot.
        sfxPlayer.powerup('gem');
        const p = deps.lazyPlayer();
        p.heal(0.2);
        p.grantJetBoost();
        nm().sendHeal(20);
        chat.add(null, 'nugget banked +1');
      } else if (e) {
        sfxPlayer.powerup(e.kind);
      }
      // Powerup kinds apply via the 'buff' message — no local effect here.
    }
  };

  // Server-applied powerup landing on us: mirror the numbers, HUD reads
  // player.armor / player.buffUntil each frame.
  networkManager.onBuff = (msg) => {
    if (deps.world.playbackMode) {return;}
    const p = deps.lazyPlayer();
    if (msg.health !== undefined) {p.health = msg.health;}
    if (msg.armor !== undefined) {p.armor = msg.armor;}
    if (msg.until !== undefined) {
      if (msg.kind === 'regen') {p.buffUntil.regen = msg.until;}
      if (msg.kind === 'dd') {p.buffUntil.dd = msg.until;}
    }
    const label = { heal: 'HEAL +50', armor: 'ARMOR +100', regen: 'REGENERATION', dd: 'DOUBLE DAMAGE' }[msg.kind];
    chat.add(null, label);
  };
}
