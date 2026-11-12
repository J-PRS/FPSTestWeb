import { MODES,TEAM_COLORS,TEAM_LABEL,CTF_PTS,CTF_DMG_PER_PTS,CTF_FLAG_ZONE_R,bank,type TeamId,type TeamScores,type ModeId} from '../../../../shared/teams.js';
import { gunGameRoll, igunChassis } from '../../../../shared/gunGame.js';
import { WeaponType } from '../../../../shared/weapons.js';
import { simRand } from '../../../../shared/simRand.js';
import { cutDemoStream } from '../demoStream.js';
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
  conquest?: { reset?(): void } | null;
  conquestWin?: string | null;
  deps: {
    world: { localTeam?: string; killCounts: Map<string, number>; deathCounts: Map<string, number>; remotePlayers: { rename(oldId: string, newId: string): void }; gungame?: boolean; igun?: boolean; gunRungs?: Map<string, number> };
    lazyPlayer?(): { armory: { setGunGameRung(rung: number, wt?: number): void } };
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
  /** Headhunt held tokens — 'local' reads the player, bots their field. */
  heldOf(id: string): number;
  setHeld(id: string, n: number): void;
  /** Match-clock origin for timer-resolved modes (headhunt resolves on
   *  winAt-held or the horn, whichever comes first). */
  matchStart: number;
}

export function winText(m: MatchHost, w: string): string {
  if (!m.spec.ffa) {return `${TEAM_LABEL[w as TeamId]} WINS — ${m.scores.alpha}:${m.scores.bravo}`;}
  const name = w === 'local' ? 'YOU' : w.replace('bot:', '');
  return `${name} WINS the ${m.spec.label.toLowerCase()} — ${m.ffaScores.get(w)} pts`;
}

/** Timer-resolved modes: at the horn the leader wins; a tie keeps
 *  playing sudden-death until the live score separates. */
export function clockWin(m: MatchHost): string | null {
  if (m.spec !== MODES.headhunt) {return null;}
  if (performance.now() - m.matchStart < m.spec.timeLimitS * 1000) {return null;}
  if (m.scores.alpha === m.scores.bravo) {return null;}
  return m.scores.alpha > m.scores.bravo ? 'alpha' : 'bravo';
}

export function checkWin(m: MatchHost): string | null {
  if (!m.spec.ffa) {
    const s = m.scores;
    if (s.alpha >= m.spec.winAt) {return 'alpha';}
    if (s.bravo >= m.spec.winAt) {return 'bravo';}
    return null;
  }
  for (const [id, sc] of m.ffaScores) {if (sc >= m.spec.winAt) {return id;}}
  return null;
}

export function pushScore(m: MatchHost): void {
  m.deps.lazyHud().setTeamScore?.(m.scores.alpha, m.scores.bravo);
}

/** Headhunt live score — recompute team totals from everyone's held
 *  tokens and push the board. Call after any held write. */
export function syncHeld(m: MatchHost): void {
  let a = 0;
  let b = 0;
  for (const [id, team] of m.teamOf) {
    const h = m.heldOf(id);
    if (team === 'alpha') {a += h;}
    else if (team === 'bravo') {b += h;}
  }
  if (m.scores.alpha !== a || m.scores.bravo !== b) {
    m.scores.alpha = a;
    m.scores.bravo = b;
    pushScore(m);
  }
}



/** Match over → wipe scores, flags home. Rounds are seamless: live
 *  bots keep their ground (hp/meters refilled), only the dead come
 *  back through the spawn ring — teleporting a healthy squad reads
 *  as a glitch, not a new match. */
export function resetMatch(m: MatchHost): void {
  m.over = null;
  m.scores.alpha = 0; m.scores.bravo = 0;
  m.matchStart = performance.now();
  for (const k of m.ffaScores.keys()) {m.ffaScores.set(k, 0);}
  // Fresh match means fresh pockets — held tokens don't carry over.
  for (const id of m.teamOf.keys()) {m.setHeld(id, 0);}
  for (const bot of m.bots) {
    bot.carryingFlag = false;
    if (bot.isDead) {m.respawnBot(bot);}
    else {
      bot.botHp = bot.botMaxHp;
      // New match, unproven bots — the meter re-earns it.
      bot.sheep = 100;
      bot.sheepShown = 100;
    }
  }
  m.dmgPool.clear();
  cutDemoStream(); // offline match end cuts the demo stream like wire's onMatchStart
  // The frag/death tallies ride kill-edge deltas with no snapshot echo —
  // same wipe the wire onMatchStart does or last match's columns linger.
  m.deps.world.killCounts.clear();
  m.deps.world.deathCounts.clear();
  // Gun-game: fresh match means fresh ladders - rung 0 + a re-rolled
  // member for every seat, same deal gunGameReset pushes on the wire.
  if (m.deps.world.gungame) {
    const igun = m.deps.world.igun === true;
    m.deps.world.gunRungs?.set('local', 0);
    m.deps.lazyPlayer?.().armory.setGunGameRung(0, gunGameRoll(0, igun, simRand()));
    for (const kb of m.bots) {
      const wt = gunGameRoll(0, igun, simRand());
      m.deps.world.gunRungs?.set(kb.playerId, 0);
      if (kb.loadout) {
        kb.loadout.near = wt; kb.loadout.mid = wt; kb.loadout.far = wt; kb.loadout.side = wt;
        kb.loadout.belt = WeaponType.Hook;
        if (igun) {kb.setBotClass(igunChassis(wt));}
      }
    }
  }
  m.ctf?.reset();
  m.rabbit?.reset();
  m.flagrun?.reset();
  m.conquest?.reset?.();
  if (m.conquestWin !== undefined) {m.conquestWin = null;}
  pushScore(m);
  m.hooks.remoteKillFeed(`${m.spec.label} — NEW MATCH`);
}

/** CTF personal board — same ffaScores map the scoreboard reads, but the
 *  payout is objective-shaped (flag-zone kills earn double). Personal
 *  points never end a match; only the team bank does. */
export function awardPersonal(m: MatchHost, id: string, n: number): void {
  if (m.over) {return;}
  m.ffaScores.set(id, (m.ffaScores.get(id) ?? 0) + n);
}

/** CTF damage economy — mirrors RoomScore.onDamage: every 100 enemy
 *  damage pays CTF_PTS.dmg, remainder pools across lives. Called from
 *  the local hit funnels AFTER the friendly/rabbit gates so blocked
 *  damage can't bank. */
export function creditDamage(m: MatchHost, attackerId: string, victimId: string, dmg: number): void {
  if (!(m.spec.flags && m.spec.teams) || attackerId === victimId || m.over) {return;}
  const a = m.teamOf.get(attackerId), v = m.teamOf.get(victimId);
  if (!a || !v || a === v) {return;}
  const acc = (m.dmgPool.get(attackerId) ?? 0) + dmg;
  const pts = Math.floor(acc / CTF_DMG_PER_PTS);
  m.dmgPool.set(attackerId, acc - pts * CTF_DMG_PER_PTS);
  if (pts > 0) {awardPersonal(m, attackerId, pts * CTF_PTS.dmg);}
}

/** DM kill credit — a player/bot frag vs a creature frag. */
export function creditKill(m: MatchHost, id: string, isCreature: boolean, victimPos?: { x: number; y: number; z: number }): void {
  // CTF personal PTS: a frag pays 1, doubled when the victim was in a
  // flag zone (defending your stand or clearing the enemy's).
  if (m.spec.flags && m.spec.teams && !isCreature) {
    awardPersonal(m, id, victimPos && m.ctf?.nearStand(victimPos, CTF_FLAG_ZONE_R) ? CTF_PTS.flagZoneKill : CTF_PTS.kill);
    return;
  }
  if (!m.spec.ffa || m.over) {return;}
  const pts = isCreature ? m.spec.ptsCreatureKill : m.spec.ptsPlayerKill;
  m.ffaScores.set(id, (m.ffaScores.get(id) ?? 0) + pts);
  const me = m.ffaScores.get('local') ?? 0;
  let lead = 0;
  for (const [, v] of m.ffaScores) {if (v > lead) {lead = v;}}
  m.deps.lazyHud().setTeamScore?.(me, lead);
}

/** A pickup was collected by 'local' or a bot id — tokens pocket into
 *  held (the live score IS the sum), gems bank for the team. */
export function collect(m: MatchHost, collectorId: string, kind?: string, val = 1): void {
  if (m.spec.ffa || m.over) {return;} // dm: nuggets heal, don't score
  const team = m.teamOf.get(collectorId) as TeamId | undefined;
  if (!team) {return;}
  if (kind === 'token') {
    // Headhunt: no bank — the token goes in your pocket and your team's
    // live score grows by your holding it.
    m.setHeld(collectorId, m.heldOf(collectorId) + val);
    awardPersonal(m, collectorId, val);
    syncHeld(m);
    return;
  }
  if (!m.spec.gems) {return;} // CTF gems heal but don't cap-score
  bank(m.scores, team);
  // Banker credit — mirrors Room.onCollect's awardPersonal so the
  // offline board's PTS column carries nuggets hauled, same as wire.
  awardPersonal(m, collectorId, 1);
  pushScore(m);
}

/** The player's live team is world.localTeam — a connected room can
 *  re-seat you on bravo after the boot-time alpha. teamOf must follow
 *  or the bots' friend/foe reads the WRONG side of the scoreboard.
 *  And if the flip lands you on the 5-bot side, a bot crosses over:
 *  the match is authored as you+4 vs 5 either way. */
export function syncLocalTeam(m: MatchHost): void {
  if (m.spec.ffa) {return;}
  let lt = m.deps.world.localTeam;
  if (lt !== 'alpha' && lt !== 'bravo') {
    // A teamless/quiet wire (offline, or a mode-less room) has no say —
    // the local squad owns the team frame. Re-assert it or every
    // friendly check (indicators, tint, scoreboard) reads all-red.
    const own = m.teamOf.get('local');
    if (own !== 'alpha' && own !== 'bravo') {return;}
    m.deps.world.localTeam = own;
    lt = own;
  }
  if (m.teamOf.get('local') === lt) {return;}
  m.teamOf.set('local', lt);
  const other: TeamId = lt === 'alpha' ? 'bravo' : 'alpha';
  const wantAllies = Math.floor(m.bots.length / 2);
  while (m.bots.filter((b): boolean => b.team === lt).length > wantAllies) {
    const b = m.bots.find((x): boolean => x.team === lt);
    if (!b) {break;}
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
    b.setColliderColor(other === lt ? 0x00_FF_00 : 0xFF_33_33);
    m.hooks.killFeed(other === 'alpha' ? 'ALPHA' : 'BRAVO', `${b.playerId.replace('bot:', '')} defects`, false, false,
      { shooter: other, target: m.teamOf.get(b.playerId) });
  }
}
