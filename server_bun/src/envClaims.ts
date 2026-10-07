import type { ClientMessage, ClaimVerdict } from './types.ts';
import { perkMods } from '../../shared/perks.ts';
import { logger } from './logger.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { CombatHandler } from './CombatHandler.ts';
import { healPool } from './healPool.ts';
import { wallNow } from './wallClock.ts';
import { evictEldest } from './evictEldest.ts';

type EnvHost = CombatHandler & { lastHeal: Map<string, number> };

// First env claim per player lands on disk (warn → server.log) — the
// INFO path is console-only, so without this edge marker a dead env
// channel is indistinguishable from a quiet one in postmortem logs.
const envSeen = new Set<string>();
const markEnvSeen = (id: string): boolean => {
  if (envSeen.has(id)) return false;
  if (envSeen.size > 512) evictEldest(envSeen);
  envSeen.add(id);
  return true;
};

  // Client-reported environmental damage (crawler pounces, etc.) — self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
export function handleEnvironmentDamage(h: EnvHost, playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): ClaimVerdict {
    const player = h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return 'gone';
    // Wire decode already finite-checks amount, but this handler is the
    // trust boundary: Math.max(1, round(NaN)) stays NaN and writes NaN
    // health into the next tick broadcast if any caller skips decode.
    if (!Number.isFinite(msg.amount)) return 'gone';
    h.hb('envdmg');
    if (markEnvSeen(playerId)) {
      logger.warn('First envDamage claim received', { playerId, amount: msg.amount, attacker: msg.attacker });
    }
    // Melee-from-afar check: creature contact damage needs a creature
    // nearby. Past ~15m there's no legal pounce — flag it in the
    // heartbeat + warn (damage still applies: this is a self-report, and
    // a bugged client shouldn't be silently maimed).
    // Attacker-tagged claims come from host-simmed sources the server has
    // no creature-range check for (team bots, deployables) — skip the
    // melee-from-afar warn and let a heavier cap cover bot melee (60).
    let attacker = typeof msg.attacker === 'string' && /^[\w: .-]{1,32}$/.test(msg.attacker)
      ? msg.attacker : undefined;
    // Forged-attribution check: a real player id is legal (victim-reported
    // splash credits the shooter), but only if that player is close
    // enough to have authored the blast — naming someone across the map
    // is a killfeed/scoreboard forge, not a bug report. 'bot:*' tags come
    // from the victim's own host sim, so they skip the range gate (the
    // server can't position-check a client-side attacker anyway).
    if (attacker && !attacker.startsWith('bot:')) {
      const src = h.playerManager.getPlayer(attacker);
      const near = src && !src.isDead &&
        Math.hypot(src.position.x - player.position.x, src.position.z - player.position.z) < 60;
      if (!near) {
        h.hb('envdmg.attackerFar');
        attacker = undefined;
      }
    }
    if (!attacker) {
      const range = h.deps.envRange?.(playerId);
      if (range !== undefined && range > 15) {
        h.hb('envdmg.far');
        logger.warn('Environment damage implausible: no creature near', { playerId, dist: Math.round(range) });
      }
    }
    const damage = Math.min(attacker ? 80 : 40, Math.max(1, Math.round(msg.amount)));
    const result = h.playerManager.applyDamage(playerId, damage);
    player.forceSendUntil = wallNow() + FORCE_SEND_MS;
    h.applyHit(attacker ?? 'environment', playerId, damage, result, { label: 'Player hit' });
    return true;
  }

  /** Free-form heal claims still need a cadence — without a credit gate
   *  (non-team rooms) a spammed claim is infinite regen. 1.5s matches the
   *  fastest honest gem-touch rhythm. */
  // Client-claimed heal — self-only. Team-mode rooms require credit the
  // server granted on a gem touch; elsewhere the claim stays free-form
  // (local nuggets in non-team rooms have no server backing). No
  // broadcast: health rides the next tickUpdate; forceSend makes sure
  // it isn't delta-suppressed.
export function handleHeal(h: EnvHost, playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): ClaimVerdict {
    const player = h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return 'gone';
    if (!Number.isFinite(msg.amount)) return 'gone'; // see envDamage guard — NaN heals poison health state
    const now = wallNow();
    if ((h.lastHeal.get(playerId) ?? 0) > now) return 'cooldown';
    const heal = Math.min(25, Math.max(1, Math.round(msg.amount * perkMods(player.perk).healBoost)));
    if (h.deps.teams) {
      if (player.healCredit <= 0) return 'nocredit';
      const applied = Math.min(heal, player.healCredit);
      player.healCredit -= applied;
      healPool(player, applied);
    } else {
      healPool(player, heal);
    }
    h.lastHeal.set(playerId, now + 1500); // a heal that landed sets the cadence; a refused one doesn't
    player.forceSendUntil = wallNow() + FORCE_SEND_MS;
    logger.info('Player healed', { playerId, heal, health: player.health });
    return true;
  }

