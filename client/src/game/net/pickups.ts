// Server-owned pickups - creature kills in team rooms drop a gem anyone on
// a team can touch to bank a point; TDM kills drop a dog tag. Dumb renderers;
// all rules (radius, TTL, team credit) live in RoomPickups server-side.

import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import { tokenTier, POWERUP, type PickupKind } from '../../../../shared/pickups.js';
import { BELT_MAX } from '../../../../shared/weapons.js';
import { pickupBurst, PICKUP_ACCENT, pickupParts } from '../../entities/PickupModel.js';
import { Nugget } from '../../entities/Nugget.js';
import * as THREE from 'three';
import * as sfxPlayer from '../../core/sfx/player.js';

const _zeroVel = new THREE.Vector3();

// Corpse-fling bookkeeping: kill visuals gib at the RENDERED position
// (what the shooter saw), but server loot scatters at wire truth -
// dropping the nugget in-place at the server pos pops it meters from
// the corpse that just fell. Record recent rendered deaths so loot can
// spawn AT the corpse the player saw and fling to its wire rest-spot -
// the scatter reads as bursting out of the body instead of teleporting.
// `wire` is the server's adjudicated death pos (playerKill.at): loot
// scatter originates there, so it pairs corpse↔drop exactly - the old
// rendered-distance guess could steal another corpse's fling in pileups.
const recentCorpses: { x: number; y: number; z: number; wire?: { x: number; y: number; z: number }; t: number; claimed?: number }[] = [];
export function noteCorpseFling(pos: { x: number; y: number; z: number }, wire?: { x: number; y: number; z: number }): void {
  const corpse = { x: pos.x, y: pos.y, z: pos.z, wire, t: performance.now() };
  recentCorpses.push(corpse);
  if (recentCorpses.length > 12) {recentCorpses.shift();}
  // Late-corpse rescue: the kill frame rides the binary lane while
  // pickupSpawn batches ride JSON - on WT those streams order
  // independently, so drops can land BEFORE their corpse exists
  // client-side. A drop parked in pendingDrops SPAWNS at this corpse -
  // it was never rendered at wire pos, so there's no pop to reconcile.
  const anchor = corpse.wire ?? corpse;
  const gate = corpse.wire ? 12 : 15;
  for (const [id, d] of pendingDrops) {
    if (Math.hypot(d.pos.x - anchor.x, d.pos.y - anchor.y, d.pos.z - anchor.z) >= gate) {continue;}
    pendingDrops.delete(id);
    clearTimeout(d.timer);
    const dx = d.pos.x - corpse.x, dy = d.pos.y - corpse.y, dz = d.pos.z - corpse.z;
    // Corpse already at the rest-spot: no fling to fake, spawn at truth.
    d.spawn(Math.hypot(dx, dy, dz) <= 0.5 ? undefined : corpse);
  }
}

/** Scatter drops whose kill frame hasn't landed client-side yet - parked
 *  spawn params, not nuggets. The drop materializes ONCE: bursting from
 *  a rescued corpse, or at wire truth when the grace timer expires. */
const pendingDrops = new Map<number, {
  pos: { x: number; y: number; z: number };
  kind: PickupKind;
  val: number;
  timer: ReturnType<typeof setTimeout>;
  spawn: (corpse?: { x: number; y: number; z: number }) => void;
}>();

/** Park a scatter drop's spawn until its kill frame lands or the 800ms
 *  grace expires - the nugget is created once, at whichever truth wins. */
function parkDrop(id: number, pos: { x: number; y: number; z: number }, kind: PickupKind, val: number, spawn: (corpse?: { x: number; y: number; z: number }) => void): void {
  cancelParked(id); // a re-spawn replaces the entry - retire its timer
  const timer = setTimeout(() => {
    // Identity check: only OUR timer may consume this entry.
    if (pendingDrops.get(id)?.timer === timer && pendingDrops.delete(id)) {spawn();}
  }, 800);
  pendingDrops.set(id, { pos, timer, spawn, kind, val });
  if (pendingDrops.size > 32) {
    // Evict the oldest parked drop rather than lose it - it materializes
    // at wire truth, the same as a grace expiry.
    const [oldestId, oldest] = pendingDrops.entries().next().value!;
    clearTimeout(oldest.timer);
    pendingDrops.delete(oldestId);
    oldest.spawn();
  }
}

function cancelParked(id: number): { kind: PickupKind; val: number } | undefined {
  const d = pendingDrops.get(id);
  if (!d) {return undefined;}
  clearTimeout(d.timer);
  pendingDrops.delete(id);
  return d;
}

/** Claim a fresh corpse for this drop: returns the corpse to spawn at
 *  (the launch vel is derived by the caller), or null. Wire-anchored
 *  corpses pair by scatter origin (pos ≈ `at`), exact under render
 *  divergence; wire-less corpses keep the rendered-proximity heuristic. */
function corpseFling(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
  const now = performance.now();
  for (let i = recentCorpses.length - 1; i >= 0; i -= 1) {
    const c = recentCorpses[i]!;
    if (now - c.t > 1500) {continue;}
    const anchor = c.wire ?? c;
    const gate = c.wire ? 12 : 15;
    if (Math.hypot(pos.x - anchor.x, pos.y - anchor.y, pos.z - anchor.z) >= gate) {continue;}
    // Claimed, not consumed: a kill scatters a GROUP (headhunt hoards,
    // the 3-gem drop) and every sibling should burst from the same
    // corpse - the 400ms window covers one pickupSpawn batch without
    // leaking the claim into the next nearby death.
    if (c.claimed !== undefined && now - c.claimed > 400) {continue;}
    c.claimed = now;
    const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
    if (Math.hypot(dx, dy, dz) <= 0.5) {return null;} // corpse already at rest-spot
    return c;
  }
  return null;
}

export function wirePickups(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  // Every pickup renders as the same Nugget class offline drops use -
  // physically tumbling, blast-scatterable; the kind reads purely by
  // tint (heal green, armor orange, tag red...). They live in the shared
  // `nuggets` array so blastForce scatters them identically and
  // updateNuggets ticks/disposes them; the server only owns spawn,
  // collect edges, and rest-spot truth.
  // New wire session: parked drops from a previous room would spawn into
  // this one on their stale timers, and old corpses could steal flings.
  for (const d of pendingDrops.values()) {clearTimeout(d.timer);}
  pendingDrops.clear();
  recentCorpses.length = 0;
  const pickupMeshes = new Map<number, { nugget: Nugget; kind: PickupKind; val: number }>();
  // Shared view for the §4.7 pickup fidelity hash - stateDebug reads the
  // same map; kind is all it needs (id is the key).
  deps.world.netPickups = pickupMeshes as Map<number, { kind: PickupKind }>;
  // Corpse-fling: a scatter pickup near a fresh rendered death spawns
  // AT the corpse the player saw and launches toward the wire pos -
  // serverRest converges it to truth when the tumble settles. Runs even
  // when the wire carries vel: kill scatters inherit the corpse's own
  // momentum (server vel is tumble truth, not scatter truth), so the
  // corpse→rest fling reads better than a pop-in at wire pos.
  const spawnNugget = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind, val: number, vel?: { x: number; y: number; z: number }, from?: { x: number; y: number; z: number }): void => {
    // Token denominations carry their own tint/size - the tier IS the
    // value read (white 1 < green 3 < blue 9 < purple 27).
    const tier = kind === 'token' ? tokenTier(val) : null;
    const spawnPos = from ?? pos;
    const spawnVel = from
      ? { x: (pos.x - from.x) / 0.45, y: (pos.y - from.y) / 0.45 + 4, z: (pos.z - from.z) / 0.45 }
      : vel;
    const nugget = new Nugget(
      deps.lazyScene(),
      new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z),
      spawnVel ? new THREE.Vector3(spawnVel.x, spawnVel.y, spawnVel.z) : _zeroVel,
      tier?.color ?? PICKUP_ACCENT[kind],
      pickupParts(kind),
      tier?.scale ?? 1,
    );
    nugget.serverOwned = true;
    // Server velocity is the truth - the constructor's random spread would
    // make the local tumble diverge from the server's and snap at rest.
    if (spawnVel) {nugget.vel.set(spawnVel.x, spawnVel.y, spawnVel.z);}
    deps.entities().nuggets.push(nugget);
    pickupMeshes.set(id, { nugget, kind, val });
  };
  /** Re-spawn for a live id: true when the id already hosts a nugget and
   *  the edge was consumed (rest-spot relaunch/rest). A kind/val swap
   *  retires the stale replica and lets the spawn continue fresh. */
  const touchLive = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind, val: number, vel?: { x: number; y: number; z: number }): boolean => {
    const live = pickupMeshes.get(id);
    if (!live) {return false;}
    if (live.kind !== kind || live.val !== val) {
      // kind is constructor-fixed (it chose the nugget's parts) - a
      // recycled id hosting a different kind can never patch its way to
      // truth and would desync the pickup hash lane forever.
      live.nugget.serverCollect();
      pickupMeshes.delete(id);
      return false;
    }
    // A blast-knock rest spot - the server's truth lands where the
    // tumble ended; converge the replica there. Launch/knock edges
    // carry vel and restart the shared tumble; a settled token takes
    // the server's rest; an in-flight replay is left alone.
    if (vel && (vel.x || vel.y || vel.z)) {live.nugget.relaunch(pos, vel);}
    else if (live.nugget.atRest) {live.nugget.serverRest(pos);}
    return true;
  };
  const addPickup = (id: number, pos: { x: number; y: number; z: number }, kind: PickupKind = 'gem', val = 1, vel?: { x: number; y: number; z: number }): void => {
    if (!Number.isFinite(pos.x + pos.y + pos.z)) {deps.logger.warn(`pickup #${id} dropped: non-finite position`); return;}
    deps.lazyDemoManager?.()?.recordPickupSpawned(id, kind, pos);
    if (touchLive(id, pos, kind, val, vel)) {return;}
    const fling = corpseFling(pos);
    if (fling) {spawnNugget(id, pos, kind, val, vel, fling); return;}
    // No fling yet - maybe the corpse's kill frame is still in flight on
    // the other lane. Park the SPAWN, not a nugget: the drop materializes
    // once - bursting from a rescued corpse (noteCorpseFling) or at wire
    // truth when the grace expires. A rendered-then-relaunched nugget was
    // the residual teleport. Scatter kinds only (gem/tag/token die out of
    // corpses) - a powerup spawn 10m off a fresh corpse must not get
    // yanked into the body. And only wire pickups (vel present, even if
    // zero) - join-snapshot rows arrive without vel and must not stall
    // 800ms behind a corpse that will never come.
    if (vel && (kind === 'gem' || kind === 'tag' || kind === 'token')) {
      parkDrop(id, pos, kind, val, (from): void => { spawnNugget(id, pos, kind, val, vel, from); });
      return;
    }
    spawnNugget(id, pos, kind, val, vel);
  };
  // Re-export on ctx - gameState needs it for pickups lying down on join.
  ctx.addPickup = addPickup;
  ctx.reconcilePickups = (liveIds): void => {
    // Ensure is a no-op - the caller feeds each row through addPickup
    // first (spawn edges keep their burst FX), this only reaps ghosts.
    const liveSet = new Set(liveIds);
    for (const [id, d] of pendingDrops) {
      if (liveSet.has(id)) {continue;}
      clearTimeout(d.timer);
      pendingDrops.delete(id);
    }
    reconcileReplicas(pickupMeshes, [...liveSet], {
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
    // A parked drop collected inside its grace never spawned - cancel the
    // timer and read its kind/val for the reward branch, same as a live e.
    const parked = cancelParked(id);
    const live = pickupMeshes.get(id);
    const e = live ?? parked;
    deps.lazyDemoManager?.()?.recordPickupGone(id);
    if (live) {
      pickupBurst(live.nugget.pos.clone(), live.kind);
      live.nugget.serverCollect();
      pickupMeshes.delete(id);
    }
    if (by === nm().getLocalPlayerId() && e) {collectReward(e);}
  };

  /** We banked it - server-verified collect pays the same rewards a local
   *  nugget gives offline (heal + jet boost), since MP drops no local loot. */
  const collectReward = (e: { kind: PickupKind; val: number }): void => {
    const p = deps.lazyPlayer();
    // Nuggets are the belt economy's income - gem, tag or token, one
    // charge back, capped at the spawn stock. Server owns the truth.
    if (e.kind === 'gem' || e.kind === 'tag' || e.kind === 'token') {
      p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
    }
    if (e.kind === 'tag') {
      sfxPlayer.powerup('tag');
      chat.add(null, 'tag confirmed +1');
    } else if (e.kind === 'gem') {
      sfxPlayer.powerup('gem');
      p.heal(0.2); // predicted - the server's own heal echoes on tickUpdate
      p.grantJetBoost();
      chat.add(null, 'nugget banked +1');
    } else if (e.kind === 'token') {
      // Held score - the playerHeld echo owns the count; the grab still
      // pays the gem's feel-good rewards, plus a tiered flat bonus so a
      // pickup has immediate utility (green +40% hp, blue +40% armor,
      // purple +5 belt + 5s 90%-block shield) on top of the sustained
      // hoard drip.
      sfxPlayer.powerup('gem');
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
    } else {
      sfxPlayer.powerup(e.kind);
    }
    // Powerup kinds apply via the 'buff' message - no local effect here.
  };

  wireBuffs(ctx);
}

/** Server-applied powerup landing on us: mirror the numbers, HUD reads
 *  player.armor / player.buffUntil each frame. */
function wireBuffs(ctx: NetCtx): void {
  const { deps, networkManager, chat } = ctx;
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
