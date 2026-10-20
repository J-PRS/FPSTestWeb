// Server-owned pickups — creature kills in team rooms drop a gem anyone on
// a team can touch to bank a point; TDM kills drop a dog tag. Dumb renderers;
// all rules (radius, TTL, team credit) live in RoomPickups server-side.

import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import type { PickupKind } from '../../../../shared/pickups.js';
import { BELT_MAX } from '../../../../shared/weapons.js';
import { pickupBurst, PICKUP_ACCENT, pickupParts } from '../../entities/PickupModel.js';
import { Nugget } from '../../entities/Nugget.js';
import { tokenTier, POWERUP } from '../../../../shared/pickups.js';
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
  const pickupMeshes = new Map<number, { nugget: Nugget; kind: PickupKind; val: number }>();
  // Shared view for the §4.7 pickup fidelity hash — stateDebug reads the
  // same map; kind is all it needs (id is the key).
  deps.world.netPickups = pickupMeshes as Map<number, { kind: PickupKind }>;
  const addPickup = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind = 'gem', val = 1, vel?: { x: number; y: number; z: number }): void => {
    if (!Number.isFinite(pos.x + pos.y + pos.z)) {deps.logger.warn(`pickup #${id} dropped: non-finite position`); return;}
    deps.lazyDemoManager?.()?.recordPickupSpawned(id, kind, pos);
    const live = pickupMeshes.get(id);
    if (live && (live.kind !== kind || live.val !== val)) {
      // kind is constructor-fixed (it chose the nugget's parts) — a
      // recycled id hosting a different kind can never patch its way to
      // truth and would desync the pickup hash lane forever.
      live.nugget.serverCollect();
      pickupMeshes.delete(id);
    } else if (live) {
      // A re-spawn for a live id is a blast-knock rest spot — the
      // server's truth lands where the tumble ended; converge the
      // replica there.
      live.nugget.serverRest(pos);
      return;
    }
    // Token denominations carry their own tint/size — the tier IS the
    // value read (white 1 < green 3 < blue 9 < purple 27).
    const tier = kind === 'token' ? tokenTier(val) : null;
    const nugget = new Nugget(
      deps.lazyScene(),
      new THREE.Vector3(pos.x, pos.y, pos.z),
      vel ? new THREE.Vector3(vel.x, vel.y, vel.z) : _zeroVel,
      tier?.color ?? PICKUP_ACCENT[kind],
      pickupParts(kind),
      tier?.scale ?? 1,
    );
    nugget.serverOwned = true;
    deps.entities().nuggets.push(nugget);
    pickupMeshes.set(id, { nugget, kind, val });
  };
  // Re-export on ctx — gameState needs it for pickups lying down on join.
  ctx.addPickup = addPickup;
  ctx.reconcilePickups = (liveIds): void => {
    // Ensure is a no-op — the caller feeds each row through addPickup
    // first (spawn edges keep their burst FX), this only reaps ghosts.
    reconcileReplicas(pickupMeshes, [...liveIds], {
      rowId: (id): number => id,
      ensure: (): undefined => undefined,
      reap: (e, id): void => {
        deps.lazyDemoManager?.()?.recordPickupGone(id);
        e.nugget.serverCollect(); // fade; updateNuggets reaps
      },
    });
  };

  networkManager.onPickupSpawn = (id, pos, kind, val, vel): void => {
    if (deps.world.playbackMode) {return;} // live match gems don't belong in the replay
    addPickup(id, pos, kind ?? 'gem', val ?? 1, vel);
  };
  networkManager.onPickupGone = (id, by): void => {
    if (deps.world.playbackMode) {return;}
    const e = pickupMeshes.get(id);
    deps.lazyDemoManager?.()?.recordPickupGone(id);
    if (e) {
      pickupBurst(e.nugget.pos.clone(), e.kind);
      e.nugget.serverCollect();
      pickupMeshes.delete(id);
    }
    if (by === nm().getLocalPlayerId()) {
      // Nuggets are the belt economy's income — gem, tag or token, one
      // charge back, capped at the spawn stock. Server owns the truth.
      if (e?.kind === 'gem' || e?.kind === 'tag' || e?.kind === 'token') {
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
        p.heal(0.2); // predicted — the server's own heal echoes on tickUpdate
        p.grantJetBoost();
        chat.add(null, 'nugget banked +1');
      } else if (e?.kind === 'token') {
        // Held score — the playerHeld echo owns the count; the grab still
        // pays the gem's feel-good rewards, plus a tiered flat bonus so a
        // pickup has immediate utility (green +40% hp, blue +40% armor,
        // purple +5 belt + 5s 90%-block shield) on top of the sustained
        // hoard drip.
        sfxPlayer.powerup('gem');
        const p = deps.lazyPlayer();
        if (e.val >= 3) {p.heal(0.4);}
        if (e.val >= 9) {p.armor = Math.min(POWERUP.maxArmor, p.armor + POWERUP.maxArmor * 0.4);}
        if (e.val >= 27) {
          p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 5);
          p.buffUntil.shield = performance.now() + 5000;
        } else {
          p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
        }
        if (e.val < 3) {p.heal(0.2);}
        p.grantJetBoost();
        chat.add(null, `token held +${e.val}`);
      } else if (e) {
        sfxPlayer.powerup(e.kind);
      }
      // Powerup kinds apply via the 'buff' message — no local effect here.
    }
  };

  // Server-applied powerup landing on us: mirror the numbers, HUD reads
  // player.armor / player.buffUntil each frame.
  networkManager.onBuff = (msg): void => {
    if (deps.world.playbackMode) {return;}
    const p = deps.lazyPlayer();
    if (msg.health !== undefined && Number.isFinite(msg.health)) {p.health = msg.health;}
    if (msg.armor !== undefined && Number.isFinite(msg.armor)) {p.armor = msg.armor;}
    if (msg.until !== undefined) {
      if (msg.kind === 'regen') {p.buffUntil.regen = msg.until;}
      if (msg.kind === 'dd') {p.buffUntil.dd = msg.until;}
      if (msg.kind === 'shield') {p.buffUntil.shield = msg.until;}
    }
    const label = { heal: 'HEAL +50', armor: 'ARMOR +100', regen: 'REGENERATION', dd: 'DOUBLE DAMAGE', shield: 'SHIELD 5s' }[msg.kind];
    if (label) {chat.add(null, label);}
  };
}
