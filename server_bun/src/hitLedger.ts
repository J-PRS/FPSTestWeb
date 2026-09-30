import { weaponStats } from './weaponStats.ts';
import { logger } from './logger.ts';
import type { CombatHandler } from './CombatHandler.ts';

// The hit funnel tail — every damage path converges here so shot/AOE/
// environment can't drift: telemetry (weapon spread, death spot, TTK),
// kill broadcast + spree callouts, corpse charge-pop, respawn timer.
// duelStart bookkeeping lives here too since only noteHit maintains it.
export class HitLedger {
  private duelStart = new Map<string, number>();

  applyHit(c: CombatHandler, shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number }): void {
    c.hb('hit');
    c.hb('dmg', Math.round(damage));
    if (result.killed) c.hb('kill');
    c.deps.onHit?.(targetId, shooterId);
    const src = opts.weapon !== undefined ? `w${opts.weapon}` : opts.label;
    this.noteHit(c, shooterId, targetId, src, damage, result.killed);
    if (!result.killed) {
      logger.info(opts.label, { shooter: shooterId, target: targetId, damage, targetHealth: result.newHealth, ...opts.extra });
      c.broadcast({ type: 'playerHit', shooterId, targetId, damage, health: result.newHealth, armor: result.newArmor });
      return;
    }
    const corpse = c.playerManager.getPlayer(targetId);
    if (corpse) c.chargeBank.corpse(shooterId, corpse); // banked LG charge goes off on the body
    this.creditKill(c, shooterId, targetId, damage, opts);
  }

  /** Telemetry + duel bookkeeping for one applied hit — weapon spread,
   *  death spot, kill speed, and first-hit→kill TTK per pairing. */
  private noteHit(c: CombatHandler, shooterId: string, targetId: string, src: string, damage: number, killed: boolean): void {
    const modeTag = c.deps.mode ?? '';
    weaponStats.record(modeTag, src, damage, killed, shooterId.startsWith('BOT-'));
    const duelKey = `${shooterId}|${targetId}`;
    if (!killed) {
      this.duelStart.set(duelKey, this.duelStart.get(duelKey) ?? Date.now());
      if (this.duelStart.size > 512) this.duelStart.clear(); // leak cap — entries die with their duels anyway
      return;
    }
    const victim = c.playerManager.getPlayer(targetId);
    if (victim) weaponStats.recordDeath(modeTag, victim.position);
    weaponStats.recordKillSpeed(modeTag,
      c.playerManager.getPlayer(shooterId)?.velocity ?? null,
      victim?.velocity ?? null);
    // Duel engagement: first-hit→kill time per shooter+victim pair.
    const started = this.duelStart.get(duelKey);
    if (started !== undefined) weaponStats.recordTtk(modeTag, src, Date.now() - started);
    this.duelStart.delete(duelKey);
  }

  /** The kill tail: score credit, kill broadcast, spree callouts, and the
   *  respawn timer — every damage path converges here. */
  private creditKill(c: CombatHandler, shooterId: string, targetId: string, damage: number, opts: { label: string; extra?: Record<string, unknown>; weapon?: number }): void {
    if (shooterId !== 'environment') c.playerManager.addKill(shooterId);
    logger.info(`${opts.label} → kill`, { shooter: shooterId, target: targetId, damage, ...opts.extra });
    const shooterStreak = shooterId === 'environment' ? undefined
      : (c.playerManager.getPlayer(shooterId)?.streak ?? 0) + 1;
    c.broadcast({ type: 'playerKill', shooterId, targetId, weapon: opts.weapon, streak: shooterStreak });
    c.killFeed.announce(shooterId, targetId);
    c.deps.onKill?.(targetId, shooterId);
    c.respawner.schedule(targetId);
  }

}
