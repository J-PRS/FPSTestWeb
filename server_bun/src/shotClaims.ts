import type { ClientMessage } from './types.ts';
import type { PlayerState } from './types.ts';
import { getWeaponStats, WeaponType, scaledDirectDamage, WEAPON_FIRE_INTERVAL_S, HEALBEAM_RANGE, HEALBEAM_PER_TICK, HEALBEAM_MIN_TICK_S, HEALBEAM_ENERGY, BELT_THROW_WEAPONS, beltThrowCost } from '../../shared/weapons.ts';
import { healPool } from './healPool.ts';
import { validateHitClaim, pointToCapsuleDistance } from '../../shared/combat.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { perkMods } from '../../shared/perks.ts';
import { rewindPos, rewindNearest, clampPing, freshDefer, type ClaimDefer } from './claimLedger.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import { logger } from './logger.ts';
import type { CombatHandler } from './CombatHandler.ts';

// Shot-claim gates: legality checks for a claimed hit, plus the spawn
// sanity check before a miss becomes a tracked projectile.

  /** A claim naming a target: every legality gate, then damage through
   *  the shared outcome funnel. */
export function hitClaim(h: CombatHandler, playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>, targetId: string, defer?: ClaimDefer): void {
    // Reject self-damage — client should never send its own ID as targetId
    if (targetId === playerId) {
      h.reject(playerId, 'Shot', 'self-target');
      return;
    }

    const target = h.playerManager.getPlayer(targetId);
    if (!target) {
      h.reject(playerId, 'Shot', 'unknown target', targetId, msg.weaponType);
      return;
    }
    // Dead targets are untouchable — without this, corpse hits still
    // broadcast playerHit and can stack phantom damage past respawn.
    // A drop, not a reject: the target was alive on the shooter's screen
    // when the shell landed but died mid-flight from another kill —
    // honest lag, and nothing is won by forging it either way.
    if (target.isDead) {
      h.hb('drop.deadTarget');
      // The shooter's predicted impact still needs clearing — this is a
      // drop (honest lag), so notify without the warn/rej bookkeeping.
      h.notifyDrop(playerId, 'Shot', 'target dead', targetId, msg.weaponType);
      return;
    }
    // Heal beam claims name a FRIEND — handle before the friendly-fire
    // gate (which would reject the whole archetype). The client latch
    // decides whom it pinned; range/energy/tick law is re-derived here.
    if (msg.weaponType === WeaponType.HealBeam) {
      healBeamClaim(h, playerId, player, targetId, target);
      return;
    }
    // Friendly fire: no damage (and no playerHit) between teammates.
    if (h.friendly(playerId, targetId)) {
      h.reject(playerId, 'Shot', 'friendly fire', targetId, msg.weaponType);
      return;
    }

    // Hit claims must name the projectile that landed them. The claimed
    // id may be null if the hit raced the server's projectileCreated —
    // fall back to the shooter's most recent spawn of that weapon type.
    const proj = h.ledger.resolve(playerId, { projectileId: msg.projectileId, clientShotId: msg.shotId, weaponType: msg.weaponType, claim: 'shot' });
    if (!proj) {
      // On unordered transports the hit can land BEFORE the spawn claim
      // registers the shell — defer for the next register() instead of
      // eating a legit hit as 'no known projectile'.
      const d = defer ?? freshDefer();
      h.deferClaim(playerId, 'Shot', d,
        (nd) => hitClaim(h, playerId, player, msg, targetId, nd), targetId, msg.weaponType);
      return;
    }
    if (msg.position === undefined || msg.airtime === undefined) {
      h.reject(playerId, 'Shot', 'missing position/airtime', targetId, msg.weaponType);
      return;
    }
    // Reorder case: the claim reached us before its spawn registered, so
    // the ledger's spawnAt understates true flight age. Bound the age by
    // the claim's own airtime — the reach/arc/occlusion checks still pin
    // the flight geometry to the real registered origin.
    if (defer) proj.spawnAt = Math.min(proj.spawnAt, Date.now() - msg.airtime * 1000);
    // Lag compensation: validate against the target's rewind PATH —
    // where the shooter saw it is anywhere in (now-ping-interp, now),
    // so a fast target's legit claim can sit several meters off the
    // single rewound point. Bounded by recorded positions, not slack.
    const targetPos = rewindNearest(target, clampPing(player.ping), 200, msg.position);
    const verdict = validateHitClaim({
      projectile: proj,
      hitPos: msg.position,
      targetPos,
      airtime: msg.airtime,
      shooterVel: player.velocity,
      now: Date.now(),
      solids: h.solids,
      targetClass: target.armorClass,
    });
    if (!verdict.ok) {
      h.reject(playerId, 'Shot', verdict.reason, targetId, msg.weaponType);
      return;
    }
    // Skillshot ramp pays on BODY contact only — a claim inside the grown
    // wake proxy is still a legal hit (flat directDamage) but doesn't earn
    // the airtime multiplier. Re-derived server-side, never trusted.
    const bodyHit = pointToCapsuleDistance(msg.position, targetPos, target.armorClass)
      <= classCapsule(target.armorClass).radius + getWeaponStats(proj.weaponType).bodyRadius;
    const shotDamage = scaledDirectDamage(proj.weaponType, bodyHit ? msg.airtime : undefined) * perkMods(player.perk).directDamage * h.ddMult(player);
    const result = h.playerManager.applyDamage(targetId, shotDamage);
    // Full-rate tick updates for the hit window — the shooter's client is
    // extrapolating this target's knockback and needs real positions to
    // converge on (suppression would leave it predicting blind).
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;

    // The server projectile id (proj_N) joins playerHit to the earlier
    // projectileCreated — that's the join accuracy stats group on.
    const projId = msg.projectileId ?? (msg.shotId ? h.ledger.idForClientShot(playerId, msg.shotId) : undefined);
    h.applyHit(playerId, targetId, shotDamage, result, { label: 'Player hit', weapon: proj.weaponType, shotId: projId ?? undefined });
    // LG charge detonation: a non-beam hit sparks min(banked, damage)
    // off the victim's bank — the rest keeps smoldering.
    if (!result.killed && proj.weaponType !== WeaponType.Lightning) {
      const acc = h.chargeBank.of(target);
      if (acc > 0) h.chargeBank.discharge(playerId, target, Math.min(acc, shotDamage));
    }
  }

  /** Heal-beam claim: friendly target only, server re-derives the tick
   *  cadence and the jet-energy cost — claims carry no amounts, so a
   *  doctored client can at most waste its own energy budget faster
   *  than the tick law allows (which the rate map blocks anyway). */
function healBeamClaim(h: CombatHandler, playerId: string, player: PlayerState, targetId: string, target: PlayerState): void {
    if (!h.friendly(playerId, targetId)) {
      h.hb('drop.healFoe'); // zapping an enemy with the med gun — no payload
      return;
    }
    // Tick law, same shape as the repair beam: one heal tick per
    // shooter+target pair per window — 15% slack for ping jitter.
    const key = `${playerId}|${targetId}`;
    const now = Date.now();
    const last = h.healTicks.get(key) ?? 0;
    if (now - last < HEALBEAM_MIN_TICK_S * 850) {
      h.hb('drop.healRate');
      return;
    }
    // Range against the target's rewound position — a skiing ally
    // outran the beam on the server clock is honest lag, not a cheat.
    const tpos = rewindPos(target, clampPing(player.ping));
    const at = rewindPos(player, clampPing(player.ping));
    const d = Math.hypot(tpos.x - at.x, tpos.y - at.y, tpos.z - at.z);
    if (d > HEALBEAM_RANGE * 1.5) {
      h.reject(playerId, 'Shot', `heal reach ${d.toFixed(1)}m > ${HEALBEAM_RANGE}m`, targetId, WeaponType.HealBeam);
      return;
    }
    // Energy is the ammo: a dry tank can't tick — drops silent, the
    // shooter's HUD already sees the empty meter.
    const tank = h.deps.energyOf?.(playerId);
    if (tank !== undefined && tank !== null && tank < HEALBEAM_ENERGY) {
      h.hb('drop.healDry');
      return;
    }
    h.deps.drainEnergy?.(playerId, HEALBEAM_ENERGY);
    h.healTicks.set(key, now);
    healPool(target, HEALBEAM_PER_TICK);
    h.hb('heal.beam');
    target.forceSendUntil = now + FORCE_SEND_MS;
    h.deps.onFire?.(playerId);
  }

  /** A claim with no target: a miss. If it carries spawn coordinates it
   *  also registers a tracked projectile observers can render. */
export function registerMiss(h: CombatHandler, playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    logger.debug('Shot fired (miss)', { shooter: playerId });
    if (!msg.position || !msg.velocity) {
      // A targetless shot with no spawn fields is a malformed claim, not
      // a legal miss — count it or the funnel reads as silent data loss.
      h.hb('drop.spawnFields');
      logger.warn(`Shot rejected: ${playerId}: miss claim missing position/velocity`);
      return;
    }

    // Idempotent resend: a client on a lossy transport retransmits spawns
    // until the projectileCreated echo lands. Dedup by spawn nonce BEFORE
    // the gates — a resend must re-ack, not consume a fire-window slot or
    // register a phantom twin.
    if (msg.shotId) {
      const known = h.ledger.idForClientShot(playerId, msg.shotId);
      if (known) {
        h.broadcast({
          type: 'projectileCreated',
          projectileId: known,
          ownerId: playerId,
          position: msg.position,
          velocity: msg.velocity,
          weaponType: msg.weaponType,
          shotId: msg.shotId,
        });
        return;
      }
    }

    // Fire-rate validation (the UE ServerFire_Validate pattern) on the
    // SPAWN claim — hit claims don't need it: the ledger already caps them
    // at one per registered projectile, so bounding spawns bounds damage.
    // A window admits `burst` claims (fan weapons register every pellet
    // in one pull); 15% slack absorbs ping jitter.
    const interval = msg.weaponType !== undefined ? WEAPON_FIRE_INTERVAL_S[msg.weaponType as WeaponType] : undefined;
    if (interval !== undefined) {
      const now = Date.now();
      const key = `${playerId}:${msg.weaponType}`;
      const win = h.fireWindows.get(key);
      if (win && now - win.start < interval * 850) {
        // Jitter compresses arrival spacing — two spawns fired a legal
        // interval apart can land inside one window on an unordered
        // transport. The claim's own fire timestamp is the escape hatch:
        // legal spacing on the client's clock still counts as one shot
        // (the ledger's per-projectile claim cap bounds damage anyway).
        const tsGapOk = msg.timestamp !== undefined && win.lastTs !== undefined
          && msg.timestamp - win.lastTs >= interval * 850;
        if (!tsGapOk && win.count >= (getWeaponStats(msg.weaponType).burst ?? 1)) {
          h.reject(playerId, 'Shot', `fire rate (${win.count + 1} claims in ${(interval * 0.85).toFixed(2)}s window)`, undefined, msg.weaponType);
          return;
        }
        win.count++;
        if (msg.timestamp !== undefined) win.lastTs = msg.timestamp;
      } else {
        h.fireWindows.set(key, { start: now, count: 1, lastTs: msg.timestamp });
      }
    }

    // Spawn sanity: the claimed muzzle position must be near where the
    // shooter was WHEN THEY FIRED — rewind by their ping (respawn,
    // knockback and teleports all legitimately move the server-side
    // position between "fire" and "claim arrives"), and the claimed
    // velocity near a real launch speed — weapon cap 250 m/s plus
    // inherited player velocity (≤300) plus slack. An uncapped claim
    // would make the reach check in validateHitClaim tautological.
    const shooterAt = rewindPos(player, clampPing(player.ping));
    const odx = msg.position.x - shooterAt.x;
    const ody = msg.position.y - shooterAt.y;
    const odz = msg.position.z - shooterAt.z;
    const vmag = Math.sqrt(
      msg.velocity.x * msg.velocity.x + msg.velocity.y * msg.velocity.y + msg.velocity.z * msg.velocity.z,
    );
    if (odx * odx + ody * ody + odz * odz > 1600 || vmag > 600) {
      h.reject(playerId, 'Shot', `implausible spawn (origin ${Math.sqrt(odx * odx + ody * ody + odz * odz).toFixed(0)}m off, v=${vmag.toFixed(0)})`, undefined, msg.weaponType);
      return;
    }
    // Belt throws are ordnance, not trigger pulls — a dry pocket can't
    // spawn one. Deduct on the spawn claim only: hit/blast claims ride
    // the registered shell and never re-pay.
    if (msg.weaponType !== undefined && BELT_THROW_WEAPONS.has(msg.weaponType)) {
      const cost = beltThrowCost(msg.weaponType);
      if (player.beltCharges < cost) {
        h.hb('drop.beltDry');
        return;
      }
      player.beltCharges -= cost;
    }
    const projectileId = h.ledger.register(playerId, msg.weaponType ?? 0, msg.position, msg.velocity, msg.shotId);
    // A registered shell may satisfy claims that arrived out of order —
    // hit/blast claims deferred on 'no known projectile' re-run here.
    h.flushClaims(playerId);
    h.broadcast({
      type: 'projectileCreated',
      projectileId,
      ownerId: playerId,
      position: msg.position,
      velocity: msg.velocity,
      weaponType: msg.weaponType,
      shotId: msg.shotId,
    });
  }

