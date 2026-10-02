import { weaponStats } from './weaponStats.ts';
// Debug probe: shooter-to-impact distance on self-kills — answers
// "do bots frag themselves with shots that pop at their own feet".
export const selfKillImpactDist: number[] = [];
import { logger } from './logger.ts';
import type { CombatHandler } from './CombatHandler.ts';
import { simNow } from './simClock.ts';

// The hit funnel tail — every damage path converges here so shot/AOE/
// environment can't drift: telemetry (weapon spread, death spot, TTK),
// kill broadcast + spree callouts, corpse charge-pop, respawn timer.
// duelStart bookkeeping lives here too since only noteHit maintains it.
export class HitLedger {
  private duelStart = new Map<string, number>();
  private hitSeq = 0; // per-room monotonic — reconnect replays carry stale seqs

  applyHit(c: CombatHandler, shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number }): void {
    c.hb('hit');
    c.hb('dmg', Math.round(damage));
    if (result.killed) c.hb('kill');
    c.deps.onHit?.(targetId, shooterId);
    const src = opts.weapon !== undefined ? `w${opts.weapon}` : opts.label;
    this.noteHit(c, shooterId, targetId, src, damage, result.killed, opts.extra?.dist as number | undefined);
    if (!result.killed) {
      logger.info(opts.label, { shooter: shooterId, target: targetId, damage, targetHealth: result.newHealth, ...opts.extra });
      c.broadcast({ type: 'playerHit', shooterId, targetId, damage, health: result.newHealth, armor: result.newArmor, seq: ++this.hitSeq });
      return;
    }
    const corpse = c.playerManager.getPlayer(targetId);
    if (corpse) c.chargeBank.corpse(shooterId, corpse); // banked LG charge goes off on the body
    this.creditKill(c, shooterId, targetId, damage, opts);
  }

  /** Telemetry + duel bookkeeping for one applied hit — weapon spread,
   *  death spot, kill speed, and first-hit→kill TTK per pairing. */
  private noteHit(c: CombatHandler, shooterId: string, targetId: string, src: string, damage: number, killed: boolean, impactDist?: number): void {
    const modeTag = c.deps.mode ?? '';
    weaponStats.record(modeTag, src, damage, killed, shooterId.startsWith('BOT-'));
    const duelKey = `${shooterId}|${targetId}`;
    if (!killed) {
      this.duelStart.set(duelKey, this.duelStart.get(duelKey) ?? simNow());
      if (this.duelStart.size > 512) this.pruneStaleDuels();
      const v = c.playerManager.getPlayer(targetId);
      if (v) c.deps.influence?.splat(v.position, c.deps.influence.dangerLayer(v.team ?? 'alpha'), 0.3);
      return;
    }
    const victim = c.playerManager.getPlayer(targetId);
    if (victim) {
      weaponStats.recordDeath(modeTag, victim.position);
      // Deaths are the loudest scent the map gets — the victim's team
      // reads its own graveyard layer when picking where NOT to walk.
      c.deps.influence?.splat(victim.position, c.deps.influence.dangerLayer(victim.team ?? 'alpha'), 2);
      c.deps.influence?.splat(victim.position, 'opportunity', 0.8);
    }
    if (shooterId === targetId && impactDist !== undefined) selfKillImpactDist.push(impactDist);
    weaponStats.recordKillSpeed(modeTag,
      c.playerManager.getPlayer(shooterId)?.velocity ?? null,
      victim?.velocity ?? null);
    // Duel engagement: first-hit→kill time per shooter+victim pair.
    const started = this.duelStart.get(duelKey);
    if (started !== undefined) weaponStats.recordTtk(modeTag, src, simNow() - started);
    this.duelStart.delete(duelKey);
  }

  // An entry is orphaned when its duel never finishes (shooter hits once
  // and disengages). Prune by age, not a hard cap — live duels keep their
  // TTK anchor no matter how many pairs are tracked. Iteration order is
  // insertion order, which approximates age order.
  private pruneStaleDuels(): void {
    const cutoff = simNow() - 60_000;
    for (const [k, t] of this.duelStart) {
      if (t > cutoff) break;
      this.duelStart.delete(k);
    }
  }

  /** The kill tail: score credit, kill broadcast, spree callouts, and the
   *  respawn timer — every damage path converges here. */
  private creditKill(c: CombatHandler, shooterId: string, targetId: string, damage: number, opts: { label: string; extra?: Record<string, unknown>; weapon?: number }): void {
    if (shooterId !== 'environment') c.playerManager.addKill(shooterId);
    logger.info(`${opts.label} → kill`, { shooter: shooterId, target: targetId, damage, ...opts.extra });
    const shooterStreak = shooterId === 'environment' ? undefined
      : (c.playerManager.getPlayer(shooterId)?.streak ?? 0) + 1;
    c.broadcast({ type: 'playerKill', shooterId, targetId, weapon: opts.weapon, streak: shooterStreak });
    c.killFeed.announce(shooterId, targetId, opts.weapon);
    c.deps.onKill?.(targetId, shooterId);
    c.respawner.schedule(targetId);
  }

}
