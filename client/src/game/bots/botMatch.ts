import { TEAM_COLORS, TEAM_LABEL, MODES, CTF_PTS, CTF_DMG_PER_PTS, CTF_FLAG_ZONE_R, bank, type TeamId, type TeamScores, type ModeId } from '../../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import type { CtfBridge } from './botCtf.js';
import type { RabbitBridge } from './botRabbit.js';

/** What the match referee reads/mutates — flat fields on TeamBots. */
export interface MatchHost {
  scores: TeamScores;
  ffaScores: Map<string, number>;
  /** CTF damage economy accumulator — remainder carries across lives. */
  dmgPool: Map<string, number>;
  over: string | null;
  overAt: number;
  spec: (typeof MODES)[ModeId];
  teamOf: Map<string, string>;
  bots: GameBot[];
  ctf: CtfBridge | null;
  rabbit: RabbitBridge | null;
  flagrun?: { reset(): void } | null;
  deps: {
    world: { localTeam?: string; remotePlayers: { rename(oldId: string, newId: string): void } };
    lazyHud(): { setTeamScore?(a: number, b: number): void; scoreboardVisible?: boolean; setScoreboardVisible?(v: boolean): void; setScoreboardCountdown?(secLeft: number | null): void };
  };
  hooks: {
    killFeed(shooter: string, victim: string, localIsShooter: boolean, localIsVictim: boolean,
      meta?: { shooter?: string; target?: string; weapon?: number; air?: number }): void;
    remoteKillFeed(text: string): void;
  };
  respawnBot(bot: GameBot): void;
  /** Jersey swap re-keys every id-keyed meter the host keeps. */
  rekeyBot(oldId: string, newId: string): void;
}

export function winText(m: MatchHost, w: string): string {
  if (!m.spec.ffa) return `${TEAM_LABEL[w as TeamId]} WINS — ${m.scores.alpha}:${m.scores.bravo}`;
  const name = w === 'local' ? 'YOU' : w.replace('bot:', '');
  return `${name} WINS the ${m.spec.label.toLowerCase()} — ${m.ffaScores.get(w)} pts`;
}

export function checkWin(m: MatchHost): string | null {
  if (!m.spec.ffa) {
    const s = m.scores;
    if (s.alpha >= m.spec.winAt) return 'alpha';
    if (s.bravo >= m.spec.winAt) return 'bravo';
    return null;
  }
  for (const [id, sc] of m.ffaScores) if (sc >= m.spec.winAt) return id;
  return null;
}

/** Match over → wipe scores, flags home. Rounds are seamless: live
 *  bots keep their ground (hp/meters refilled), only the dead come
 *  back through the spawn ring — teleporting a healthy squad reads
 *  as a glitch, not a new match. */
export function resetMatch(m: MatchHost): void {
  m.over = null;
  m.scores.alpha = 0; m.scores.bravo = 0;
  for (const k of m.ffaScores.keys()) m.ffaScores.set(k, 0);
  for (const bot of m.bots) {
    bot.carryingFlag = false;
    if (bot.isDead) m.respawnBot(bot);
    else {
      bot.botHp = bot.botMaxHp;
      // New match, unproven bots — the meter re-earns it.
      bot.sheep = 100;
      bot.sheepShown = 100;
    }
  }
  m.dmgPool.clear();
  m.ctf?.reset();
  m.rabbit?.reset();
  m.flagrun?.reset();
  pushScore(m);
  m.hooks.remoteKillFeed(`${m.spec.label} — NEW MATCH`);
}

/** CTF personal board — same ffaScores map the scoreboard reads, but the
 *  payout is objective-shaped (flag-zone kills earn double). Personal
 *  points never end a match; only the team bank does. */
export function awardPersonal(m: MatchHost, id: string, n: number): void {
  if (m.over) return;
  m.ffaScores.set(id, (m.ffaScores.get(id) ?? 0) + n);
}

/** CTF damage economy — mirrors RoomScore.onDamage: every 100 enemy
 *  damage pays CTF_PTS.dmg, remainder pools across lives. Called from
 *  the local hit funnels AFTER the friendly/rabbit gates so blocked
 *  damage can't bank. */
export function creditDamage(m: MatchHost, attackerId: string, victimId: string, dmg: number): void {
  if (!(m.spec.flags && m.spec.teams) || attackerId === victimId || m.over) return;
  const a = m.teamOf.get(attackerId), v = m.teamOf.get(victimId);
  if (!a || !v || a === v) return;
  const acc = (m.dmgPool.get(attackerId) ?? 0) + dmg;
  const pts = Math.floor(acc / CTF_DMG_PER_PTS);
  m.dmgPool.set(attackerId, acc - pts * CTF_DMG_PER_PTS);
  if (pts > 0) awardPersonal(m, attackerId, pts * CTF_PTS.dmg);
}

/** DM kill credit — a player/bot frag vs a creature frag. */
export function creditKill(m: MatchHost, id: string, isCreature: boolean, victimPos?: { x: number; y: number; z: number }): void {
  // CTF personal PTS: a frag pays 1, doubled when the victim was in a
  // flag zone (defending your stand or clearing the enemy's).
  if (m.spec.flags && m.spec.teams && !isCreature) {
    awardPersonal(m, id, victimPos && m.ctf?.nearStand(victimPos, CTF_FLAG_ZONE_R) ? CTF_PTS.flagZoneKill : CTF_PTS.kill);
    return;
  }
  if (!m.spec.ffa || m.over) return;
  const pts = isCreature ? m.spec.ptsCreatureKill : m.spec.ptsPlayerKill;
  m.ffaScores.set(id, (m.ffaScores.get(id) ?? 0) + pts);
  const me = m.ffaScores.get('local') ?? 0;
  let lead = 0;
  for (const [, v] of m.ffaScores) if (v > lead) lead = v;
  m.deps.lazyHud().setTeamScore?.(me, lead);
}

/** A nugget was collected by 'local' or a bot id — bank it for the team. */
export function collect(m: MatchHost, collectorId: string): void {
  if (m.spec.ffa || m.over) return; // dm: nuggets heal, don't score
  // Networked matches score through server-owned gems (RoomPickups
  // touch) — the teamScore echo is the truth; this local board is the
  // offline path's own scoreboard.
  const team = m.teamOf.get(collectorId) as TeamId | undefined;
  if (!team || !m.spec.gems) return; // CTF gems heal but don't cap-score
  bank(m.scores, team);
  // Banker credit — mirrors Room.onCollect's awardPersonal so the
  // offline board's PTS column carries nuggets hauled, same as wire.
  awardPersonal(m, collectorId, 1);
  pushScore(m);
}

export function pushScore(m: MatchHost): void {
  m.deps.lazyHud().setTeamScore?.(m.scores.alpha, m.scores.bravo);
}

/** The player's live team is world.localTeam — a connected room can
 *  re-seat you on bravo after the boot-time alpha. teamOf must follow
 *  or the bots' friend/foe reads the WRONG side of the scoreboard.
 *  And if the flip lands you on the 5-bot side, a bot crosses over:
 *  the match is authored as you+4 vs 5 either way. */
export function syncLocalTeam(m: MatchHost): void {
  if (m.spec.ffa) return;
  let lt = m.deps.world.localTeam;
  if (lt !== 'alpha' && lt !== 'bravo') {
    // A teamless/quiet wire (offline, or a mode-less room) has no say —
    // the local squad owns the team frame. Re-assert it or every
    // friendly check (indicators, tint, scoreboard) reads all-red.
    const own = m.teamOf.get('local');
    if (own !== 'alpha' && own !== 'bravo') return;
    m.deps.world.localTeam = own;
    lt = own;
  }
  if (m.teamOf.get('local') === lt) return;
  m.teamOf.set('local', lt);
  const other: TeamId = lt === 'alpha' ? 'bravo' : 'alpha';
  const wantAllies = Math.floor(m.bots.length / 2);
  while (m.bots.filter(b => b.team === lt).length > wantAllies) {
    const b = m.bots.find(x => x.team === lt);
    if (!b) break;
    // Jersey swap — rename the id so the scoreboard's -A/-B suffix
    // stays truthful, then re-key every roster that holds it.
    const oldId = b.playerId;
    const newId = oldId.replace(/-[AB]$/, `-${other === 'alpha' ? 'A' : 'B'}`);
    if (newId !== oldId) {
      m.deps.world.remotePlayers.rename(oldId, newId);
      m.teamOf.delete(oldId);
      b.playerId = newId;
      // Every id-keyed meter re-keys with the jersey — a stale entry is
      // a leak AND the defector would re-think/re-meter from zero.
      m.rekeyBot(oldId, newId);
    }
    b.team = other;
    m.teamOf.set(b.playerId, other);
    b.setGizmoColor(TEAM_COLORS[other]);
    // Defectors flip to the enemy side — recolor the debug hitbox too.
    b.setColliderColor(other === lt ? 0x00ff00 : 0xff3333);
    m.hooks.killFeed(other === 'alpha' ? 'ALPHA' : 'BRAVO', `${b.playerId.replace('bot:', '')} defects`, false, false,
      { shooter: other, target: m.teamOf.get(b.playerId) });
  }
}
