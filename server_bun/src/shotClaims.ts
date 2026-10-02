import type { ClientMessage } from './types.ts';
import type { PlayerState } from './types.ts';
import { getWeaponStats, WeaponType, scaledDirectDamage, WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import { validateHitClaim, pointToCapsuleDistance } from '../../shared/combat.ts';
import { PLAYER_RADIUS } from '../../shared/constants.ts';
import { perkMods } from '../../shared/perks.ts';
import { rewindPos, clampPing } from './claimLedger.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import { logger } from './logger.ts';
import type { CombatHandler } from './CombatHandler.ts';

// Shot-claim gates: legality checks for a claimed hit, plus the spawn
// sanity check before a miss becomes a tracked projectile.

  /** A claim naming a target: every legality gate, then damage through
   *  the shared outcome funnel. */
export function hitClaim(h: CombatHandler, playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>, targetId: string): void {
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
    if (target.isDead) {
      h.reject(playerId, 'Shot', 'target already dead', targetId, msg.weaponType);
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
      h.reject(playerId, 'Shot', `no known projectile (id=${msg.projectileId ?? 'null'})`, targetId, msg.weaponType);
      return;
    }
    if (msg.position === undefined || msg.airtime === undefined) {
      h.reject(playerId, 'Shot', 'missing position/airtime', targetId, msg.weaponType);
      return;
    }
    // Lag compensation: validate against where the target was when the
    // shooter saw it (now - ping), not where it is now — otherwise a
    // 100ms client aims at ghosts by design.
    const targetPos = rewindPos(target, clampPing(player.ping));
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
      <= PLAYER_RADIUS + getWeaponStats(proj.weaponType).bodyRadius;
    const shotDamage = scaledDirectDamage(proj.weaponType, bodyHit ? msg.airtime : undefined) * perkMods(player.perk).directDamage * h.ddMult(player);
    const result = h.playerManager.applyDamage(targetId, shotDamage);
    // Full-rate tick updates for the hit window — the shooter's client is
    // extrapolating this target's knockback and needs real positions to
    // converge on (suppression would leave it predicting blind).
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;

    h.applyHit(playerId, targetId, shotDamage, result, { label: 'Player hit', weapon: proj.weaponType });
    // LG charge detonation: a non-beam hit sparks min(banked, damage)
    // off the victim's bank — the rest keeps smoldering.
    if (!result.killed && proj.weaponType !== WeaponType.Lightning) {
      const acc = h.chargeBank.of(target);
      if (acc > 0) h.chargeBank.discharge(playerId, target, Math.min(acc, shotDamage));
    }
  }

  /** A claim with no target: a miss. If it carries spawn coordinates it
   *  also registers a tracked projectile observers can render. */
export function registerMiss(h: CombatHandler, playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    logger.debug('Shot fired (miss)', { shooter: playerId });
    if (!msg.position || !msg.velocity) return;

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
        if (win.count >= (getWeaponStats(msg.weaponType).burst ?? 1)) {
          h.reject(playerId, 'Shot', `fire rate (${win.count + 1} claims in ${(interval * 0.85).toFixed(2)}s window)`, undefined, msg.weaponType);
          return;
        }
        win.count++;
      } else {
        h.fireWindows.set(key, { start: now, count: 1 });
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
    const projectileId = h.ledger.register(playerId, msg.weaponType ?? 0, msg.position, msg.velocity, msg.shotId);
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

