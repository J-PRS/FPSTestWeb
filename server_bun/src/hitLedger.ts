import { weaponStats } from './weaponStats.ts';
import { WeaponType } from '../../shared/weapons.ts';
// Debug probe: shooter-to-impact distance on self-kills — answers
// "do bots frag themselves with shots that pop at their own feet".
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
  if (arr.length > PROBE_CAP) arr.splice(0, arr.length - PROBE_CAP);
}
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

  applyHit(c: CombatHandler, shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; shotId?: string; air?: number }): void {
    c.hb('hit');
    c.hb('dmg', Math.round(damage));
    if (result.killed) c.hb('kill');
    c.deps.emit?.({ type: 'hit', targetId, shooterId, damage });
    const src = opts.weapon !== undefined ? `w${opts.weapon}` : opts.label;
    this.noteHit(c, shooterId, targetId, src, damage, result.killed, { dist: opts.extra?.dist as number | undefined, pos: opts.extra?.pos as { x: number; y: number; z: number } | undefined });
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
          if (acc > 0) c.chargeBank.discharge(shooterId, v, Math.min(acc, damage));
        }
      }
      logger.debug(opts.label, { shooter: shooterId, target: targetId, damage, targetHealth: result.newHealth, ...opts.extra });
      c.broadcast({ type: 'playerHit', shooterId, targetId, damage, health: result.newHealth, armor: result.newArmor, seq: ++this.hitSeq, shotId: opts.shotId });
      return;
    }
    const corpse = c.playerManager.getPlayer(targetId);
    if (corpse) c.chargeBank.corpse(shooterId, corpse); // banked LG charge goes off on the body
    this.creditKill(c, shooterId, targetId, damage, opts);
  }

  /** Telemetry + duel bookkeeping for one applied hit — weapon spread,
   *  death spot, kill speed, and first-hit→kill TTK per pairing. */
  private noteHit(c: CombatHandler, shooterId: string, targetId: string, src: string, damage: number, killed: boolean, impact: { dist?: number; pos?: { x: number; y: number; z: number } } = {}): void {
    const { dist: impactDist, pos: impactPos } = impact;
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
    if (shooterId === targetId && impactDist !== undefined) probePush(selfKillImpactDist, impactDist);
    if (shooterId === targetId && impactPos) {
      probePush(selfKillImpactPos, { x: impactPos.x, y: impactPos.y, z: impactPos.z });
      const near = c.deps.preyNear?.(impactPos, shooterId);
      if (near) probePush(selfKillPrey, near);
    }
    if (shooterId === targetId) {
      const me2 = c.playerManager.getPlayer(shooterId);
      if (me2) {
        let foeD = Infinity;
        for (const o of c.playerManager.getAllPlayers().values()) {
          if (o.team === me2.team || o.isDead) continue;
          const d = Math.hypot(o.position.x - me2.position.x, o.position.z - me2.position.z);
          if (d < foeD) foeD = d;
        }
        probePush(selfKillFoeDist, foeD);
      }
    }
    // Trade accounting runs both directions of the batch: a self-frag
    // after a same-window enemy kill, or the enemy kill landing first.
    const now0 = simNow();
    if (recentKills.some((k) => k.shooterId === shooterId && now0 - k.t <= TRADE_MS)) selfKillTrades.trades++;
    recentKills.push({ t: now0, shooterId });
    if (recentKills.length > 256) recentKills.splice(0, recentKills.length - 256);
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
  private creditKill(c: CombatHandler, shooterId: string, targetId: string, damage: number, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; air?: number }): void {
    // Self-frags are deaths, not kills — the kill feed already says so;
    // kills++/killTotal must agree or suicides pad the scoreboard and
    // can even fake "first blood".
    if (shooterId !== 'environment' && shooterId !== targetId) c.playerManager.addKill(shooterId);
    logger.info(`${opts.label} → kill`, { shooter: shooterId, target: targetId, damage, ...opts.extra });
    const shooterStreak = shooterId === 'environment' ? undefined
      : (c.playerManager.getPlayer(shooterId)?.streak ?? 0) + 1;
    c.broadcast({ type: 'playerKill', shooterId, targetId, weapon: opts.weapon, streak: shooterStreak, air: opts.air });
    c.killFeed.announce(shooterId, targetId, opts.weapon, opts.label);
    c.deps.emit?.({ type: 'kill', targetId, shooterId });
    c.respawner.schedule(targetId);
  }

}
