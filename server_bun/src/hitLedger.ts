import { weaponStats } from './weaponStats.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { perkMods } from '../../shared/perks.ts';
import { healPool } from './healPool.ts';
// Debug probe: shooter-to-impact distance on self-kills — answers
// "do bots frag themselves with shots that pop at their own feet".
import { logger } from './logger.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import type { ServerMessage } from './types.ts';
import type { CombatHandler, CombatDeps } from './CombatHandler.ts';
import { simNow } from './simClock.ts';
import { encodeKill } from '../../shared/wire.ts';
export const selfKillImpactDist: number[] = [];
/** Blast point of each self-frag — lets the soak autopsy classify what
 *  the shell actually struck (lip, stray ball, teammate, open air). */
export const selfKillImpactPos: { x: number; y: number; z: number }[] = [];
/** Nearest ball / crawler distance at each self-frag — a pop <2m over
 *  ground is still a body intercept if a crawler is standing there. */
export const selfKillPrey: { ball: number; crawler: number; foe: number }[] = [];
/** Nearest-enemy range at the moment of self-frag — separates the
 *  "enemy on top of me" splash from the "shell clipped a lip" kind. */
export const selfKillFoeDist: number[] = [];
/** Traded self-frags: the same shooter killed an enemy within the same
 *  blast window — human sacrifice; the rest are pure waste. */
export const selfKillTrades: { trades: number } = { trades: 0 };
const recentKills: { t: number; shooterId: string }[] = [];
const TRADE_MS = 300;
// Debug probes below are module-global — a long-lived room pushes one
// entry per self-frag forever. Same tail-cap shape as recentKills.
const PROBE_CAP = 256;
function probePush<T>(arr: T[], v: T): void {
  arr.push(v);
  if (arr.length > PROBE_CAP) {arr.splice(0, arr.length - PROBE_CAP);}
}

// Structural slice — the ledger may read hit telemetry deps and write
// through the broadcast/kill/respawn funnels, nothing else. Pick<> keeps
// the fields synced with the handler they slice.
export type LedgerHost = Pick<CombatHandler,
  'broadcast' | 'chargeBank' | 'playerManager' | 'killFeed' | 'respawner' | 'hb' | 'deps'
> & { deps: Pick<CombatDeps, 'emit' | 'influence' | 'mode' | 'preyNear' | 'wireHit' | 'widOf' | 'wireCast'> };

// The hit funnel tail — every damage path converges here so shot/AOE/
// environment can't drift: telemetry (weapon spread, death spot, TTK),
// kill broadcast + spree callouts, corpse charge-pop, respawn timer.
// duelStart bookkeeping lives here too since only noteHit maintains it.
export class HitLedger {
  private duelStart = new Map<string, number>();
  private hitSeq = 0; // per-room monotonic — reconnect replays carry stale seqs

  applyHit(c: LedgerHost, shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number; endedStreak?: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; shotId?: string; air?: number; gd?: number }): void {
    // Corpse hits are pure noise: applyDamage already no-ops them
    // (killed=false), so every ungated path still emitted a wire
    // playerHit + poisoned noteHit/charge bookkeeping - the blast lane
    // was the live offender (~40 hits/30s on a dead client, duelsoak).
    // The kill path stays: killed=true means the victim was alive when
    // the damage landed.
    if (!result.killed && c.playerManager.getPlayer(targetId)?.isDead) {c.hb('drop.deadVictim'); return;}
    // Zero-damage resolves (soaked, immune, out-of-band splashes) must
    // not emit playerHit - every client reads the edge as a white-pop
    // flinch on the victim, so a null hit lies about contact.
    if (damage <= 0) {c.hb('drop.zeroDamage'); return;}
    c.hb('hit');
    c.hb('dmg', Math.round(damage));
    if (result.killed) {c.hb('kill');}
    c.deps.emit?.({ type: 'hit', targetId, shooterId, damage });
    const src = opts.weapon === undefined ? opts.label : `w${opts.weapon}`;
    this.noteHit(c, shooterId, targetId, src, damage, result.killed, { dist: opts.extra?.dist as number | undefined, pos: opts.extra?.pos as { x: number; y: number; z: number } | undefined, shotId: opts.shotId });
    if (!result.killed) {
      // Surviving victim pops min(banked, damage) of their LG charge —
      // one rule for every damage path so a splash or mine can't carry
      // less detonation than a body shot. Beams, self-hits and
      // 'environment' never pop (a beam's bank is still accumulating,
      // and the bank's owner attacks things, not victimless forces).
      if (opts.weapon !== WeaponType.Lightning && shooterId !== targetId && shooterId !== 'environment') {
        const v = c.playerManager.getPlayer(targetId);
        if (v) {
          const acc = c.chargeBank.of(v);
          if (acc > 0) {c.chargeBank.discharge(shooterId, v, Math.min(acc, damage));}
        }
      }
      if (logger.enabled('debug')) {logger.debug(opts.label, Object.assign({}, {shooter: shooterId,target: targetId,damage,targetHealth: result.newHealth}, opts.extra));}
      const hitMsg = { shooterId, targetId, damage, health: result.newHealth, armor: result.newArmor, seq: (this.hitSeq += 1), shotId: opts.shotId, gd: opts.gd };
      // Binary lane when wireIds resolve (players, 'environment' → wid 0);
      // JSON broadcast stays the fallback for harnesses and unminted ids.
      if (c.deps.wireHit?.(hitMsg) !== true) {
        c.broadcast(eventPayload(WORLD_MODEL.player!, 'playerHit', 'targetId', targetId, hitMsg) as ServerMessage);
      }
      return;
    }
    const corpse = c.playerManager.getPlayer(targetId);
    if (corpse) {c.chargeBank.corpse(shooterId, corpse);} // banked LG charge goes off on the body
    this.creditKill(c, shooterId, targetId, damage, opts, result.endedStreak);
  }

  /** Telemetry + duel bookkeeping for one applied hit — weapon spread,
   *  death spot, kill speed, and first-hit→kill TTK per pairing. */
  private noteHit(c: LedgerHost, shooterId: string, targetId: string, src: string, damage: number, killed: boolean, impact: { dist?: number; pos?: { x: number; y: number; z: number }; shotId?: string } = {}): void {
    const { dist: impactDist, pos: impactPos } = impact;
    const modeTag = c.deps.mode ?? '';
    // Band the hit by live shooter→victim gap — extra.dist is the
    // optional impact hint; positions are always there and mean the same
    // thing recordShot bins (shooter→aim distance).
    const sp = c.playerManager.getPlayer(shooterId)?.position;
    const tp = c.playerManager.getPlayer(targetId)?.position;
    const gap = sp && tp ? Math.hypot(tp.x - sp.x, tp.z - sp.z) : impactDist;
    const killVictim = killed ? c.playerManager.getPlayer(targetId) : undefined;
    weaponStats.record(modeTag, src, damage, killed, shooterId.startsWith('BOT-'), gap, impact.shotId, killed ? `${targetId}|${killVictim?.deaths ?? 0}` : undefined, targetId);
    const duelKey = `${shooterId}|${targetId}`;
    if (!killed) {
      this.duelStart.set(duelKey, this.duelStart.get(duelKey) ?? simNow());
      if (this.duelStart.size > 512) {this.pruneStaleDuels();}
      const v = c.playerManager.getPlayer(targetId);
      if (v) {c.deps.influence?.splat(v.position, c.deps.influence.dangerLayer(v.team ?? 'alpha'), 0.3);}
      return;
    }
    const victim = killVictim;
    if (victim) {
      weaponStats.recordDeath(modeTag, victim.position);
      // Deaths are the loudest scent the map gets — the victim's team
      // reads its own graveyard layer when picking where NOT to walk.
      c.deps.influence?.splat(victim.position, c.deps.influence.dangerLayer(victim.team ?? 'alpha'), 2);
      c.deps.influence?.splat(victim.position, 'opportunity', 0.8);
    }
    if (shooterId === targetId && impactDist !== undefined) {probePush(selfKillImpactDist, impactDist);}
    if (shooterId === targetId && impactPos) {
      probePush(selfKillImpactPos, { x: impactPos.x, y: impactPos.y, z: impactPos.z });
      const near = c.deps.preyNear?.(impactPos, shooterId);
      if (near) {probePush(selfKillPrey, near);}
    }
    if (shooterId === targetId) {
      const me2 = c.playerManager.getPlayer(shooterId);
      if (me2) {
        let foeD = Infinity;
        for (const o of c.playerManager.getAllPlayers().values()) {
          if (o.team === me2.team || o.isDead) {continue;}
          const d = Math.hypot(o.position.x - me2.position.x, o.position.z - me2.position.z);
          if (d < foeD) {foeD = d;}
        }
        probePush(selfKillFoeDist, foeD);
      }
    }
    // Trade accounting runs both directions of the batch: a self-frag
    // after a same-window enemy kill, or the enemy kill landing first.
    const now0 = simNow();
    if (recentKills.some((k): boolean => k.shooterId === shooterId && now0 - k.t <= TRADE_MS)) {selfKillTrades.trades += 1;}
    recentKills.push({ t: now0, shooterId });
    if (recentKills.length > 256) {recentKills.splice(0, recentKills.length - 256);}
    weaponStats.recordKillSpeed(modeTag,
      c.playerManager.getPlayer(shooterId)?.velocity ?? null,
      victim?.velocity ?? null);
    // Duel engagement: first-hit→kill time per shooter+victim pair.
    const started = this.duelStart.get(duelKey);
    if (started !== undefined) {weaponStats.recordTtk(modeTag, src, simNow() - started);}
    this.duelStart.delete(duelKey);
  }

  // An entry is orphaned when its duel never finishes (shooter hits once
  // and disengages). Prune by age, not a hard cap — live duels keep their
  // TTK anchor no matter how many pairs are tracked. Iteration order is
  // insertion order, which approximates age order.
  private pruneStaleDuels(): void {
    const cutoff = simNow() - 60_000;
    for (const [k, t] of this.duelStart) {
      if (t > cutoff) {break;}
      this.duelStart.delete(k);
    }
  }

  /** The kill tail: score credit, kill broadcast, spree callouts, and the
   *  respawn timer — every damage path converges here. */
  private creditKill(c: LedgerHost, shooterId: string, targetId: string, damage: number, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; air?: number }, endedStreak?: number): void {
    // Self-frags are deaths, not kills — the kill feed already says so;
    // kills++/killTotal must agree or suicides pad the scoreboard and
    // can even fake "first blood".
    if (shooterId !== 'environment' && shooterId !== targetId) {c.playerManager.addKill(shooterId);}
    // Lifesteal: a melee frag pays the kill back as health (lance frags
    // pay half — the zap is easier than the punch but still a closing
    // weapon). Every hit still deals its listed damage — the
    // survivability only lands on the kill edge, so hits-to-kill stays
    // countable.
    let steal = false;
    const stealFrac = opts.weapon === WeaponType.Melee ? 1 : opts.weapon === WeaponType.Shocklance ? 0.5 : 0;
    if (stealFrac > 0 && shooterId !== 'environment' && shooterId !== targetId) {
      const shooter = c.playerManager.getPlayer(shooterId);
      const mh = shooter ? perkMods(shooter.perk).meleeHeal : 0;
      if (shooter && mh > 0 && !shooter.isDead) {healPool(shooter, shooter.maxHealth * mh * stealFrac); steal = true;}
    }
    if (logger.enabled('info')) {logger.info(`${opts.label} → kill`, Object.assign({}, {shooter: shooterId,target: targetId,damage}, opts.extra));}
    const shooterStreak = shooterId === 'environment' ? undefined
      : (c.playerManager.getPlayer(shooterId)?.streak ?? 0) + 1;
    // Binary lane when wireIds resolve — durable journal either way
    // (kills are the event history a reclaim replays).
    const killWids = c.deps.widOf;
    const tw = killWids?.(targetId);
    const sw = shooterId === 'environment' ? 0 : killWids?.(shooterId);
    if (tw !== undefined && sw !== undefined && c.deps.wireCast) {
      c.deps.wireCast(encodeKill({ shooterWid: sw, targetWid: tw, weapon: opts.weapon, streak: shooterStreak, air: opts.air, steal }), true);
    } else {
      c.broadcast(eventPayload(WORLD_MODEL.player!, 'playerKill', 'targetId', targetId, { shooterId, weapon: opts.weapon, streak: shooterStreak, air: opts.air, steal }) as ServerMessage);
    }
    c.killFeed.announce(shooterId, targetId, opts.weapon, opts.label, opts.air, endedStreak, simNow());
    c.deps.emit?.({ type: 'kill', targetId, shooterId, weapon: opts.weapon });
    c.respawner.schedule(targetId);
  }

}
