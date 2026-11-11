// Match lifecycle + score events — chat announcements plus the center
// banner + horn stinger on match boundaries.

import type { NetCtx } from './ctx.js';
import * as sfx from '../../core/sfx.js';
import { speakAnnounce } from '../../core/tts.js';
import { MODES, type ModeId } from '../../../../shared/teams.js';

/** Multi-kill names by chain — the booth reads these, not the feed's
 *  lowercase 'double kill (2)'. Clip = the WARLORD pack sample; quad+
 *  rides 'annihilation' (the pack has no quad line). */
const MULTI_BANNER: Record<number, string> = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL' };
const multiClip = (n: number): string => {
  if (n === 2) {return 'announce_double';}
  if (n === 3) {return 'announce_triple';}
  return 'announce_annihilation';
};
/** ann key → banner + WARLORD clip.
 *
 *  Canonical UT ladder (also the client's STREAK_NAMES and the
 *  server's SPREE_TIERS — all three must agree):
 *    5 Killing Spree · 10 Rampage · 15 Dominating · 20 Unstoppable
 *    25 Godlike · 30 Wicked Sick (re-announces every +5 past 30)
 *
 *  WARLORD coverage gaps → our substitutions:
 *    killing spree → killshot     (pack has no 'killing spree' line)
 *    wicked sick   → annihilation (no 'wicked sick'; also the quad+
 *                                  multi-kill clip — both are
 *                                  lobby-destruction moments)
 *    godlike       → eradication
 *    multi 2/3/4+  → double / triple / annihilation (no 'quad kill'
 *                    line in the pack)
 *  Missing a clip entirely → speakAnnounce falls back to system TTS. */
const ANNOUNCE: Record<string, { banner: string; clip?: string }> = {
  firstblood: { banner: 'FIRST BLOOD', clip: 'announce_firstblood' },
  killing_spree: { banner: 'KILLING SPREE', clip: 'announce_killshot' },
  rampage: { banner: 'RAMPAGE', clip: 'announce_rampage' },
  dominating: { banner: 'DOMINATING', clip: 'announce_dominating' },
  unstoppable: { banner: 'UNSTOPPABLE', clip: 'announce_unstoppable' },
  godlike: { banner: 'GODLIKE', clip: 'announce_eradication' },
  wicked_sick: { banner: 'WICKED SICK', clip: 'announce_annihilation' },
};

export function wireMatchEvents(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  // End-of-match standings: pin the scoreboard at the horn unless the
  // player already had it open — auto-shown means auto-dismissed at the
  // next matchStart, so a deliberate Tab is never hijacked.
  let sbAutoShown = false;
  const pinScoreboard = (): void => {
    const hud = deps.lazyHud();
    if (hud.scoreboardVisible) {return;}
    hud.setScoreboardVisible(true);
    sbAutoShown = true;
  };
  const releaseScoreboard = (): void => {
    if (!sbAutoShown) {return;}
    sbAutoShown = false;
    deps.lazyHud().setScoreboardVisible(false);
  };

  // Score-spam filter: teamScore broadcasts on EVERY scoring event — in
  // nuggets that's one line per gem banked, and the feed drowns. Announce
  // only lead changes, every 10-pt milestone, and the endgame stretch
  // (within 10 of the cap) where each point actually matters.
  let lastLead = '';
  let lastMilestone = -1;
  networkManager.onTeamScore = (scores, winAt): void => {
    if (!Number.isFinite(scores.alpha + scores.bravo + winAt)) {return;}
    deps.world.teamScores = scores;
    deps.lazyHud().setTeamScore?.(scores.alpha, scores.bravo);
    const top = Math.max(scores.alpha, scores.bravo);
    let lead = 'bravo';
if (scores.alpha === scores.bravo) {lead = 'tie';}
else if (scores.alpha > scores.bravo) {lead = 'alpha';}
    const milestone = Math.floor(top / 10);
    if (lead !== lastLead || milestone > lastMilestone || top >= winAt - 10) {
      chat.add(null, `ALPHA ${scores.alpha} : ${scores.bravo} BRAVO  (first to ${winAt})`);
      lastLead = lead;
      lastMilestone = milestone;
    }
  };
  networkManager.onFfaScore = (scores, winAt, deltaId, deltaScore, rm): void => {
    let board = deps.world.ffaScores;
    if (deltaId === undefined) {
      if (!scores || Object.values(scores).some((v): boolean => !Number.isFinite(v))) {return;}
      board = deps.world.ffaScores = new Map(Object.entries(scores));
    } else {
      // Steady-state delta — merge one row; the full-board replace below
      // stays for legacy peers and the join snapshot.
      if (rm) {board.delete(deltaId);}
      else if (Number.isFinite(deltaScore)) {board.set(deltaId, deltaScore!);}
      else {return;}
    }
    if (!Number.isFinite(winAt)) {return;}
    const me = nm().getLocalPlayerId();
    const mine = board.get(me) ?? 0;
    let lead = 0; for (const v of board.values()) {if (v > lead) {lead = v;}}
    // Only announce when the lead changes hands or YOU score — a per-kill
    // feed line for every bot frag would drown the chat. Team modes reuse
    // the same channel for the personal PTS column — silent there, the
    // win is the team bank, not a personal race to winAt.
    if (MODES[deps.world.mode as ModeId]?.ffa && mine > 0) {
      chat.add(null, `you: ${mine} pts (leader ${lead}/${winAt})`);
    }
  };
  networkManager.onFfaMatchEnd = (winner, scores): void => {
    const me = nm().getLocalPlayerId();
    const iWon = winner === me;
    chat.add(null, winner === 'draw'
      ? 'DRAW — time\'s up, new match starting'
      : `${winner} WINS the deathmatch — ${scores[winner]} pts — new match starting`);
    let endMsg;
    if (winner === 'draw') {endMsg = 'DRAW';}
    else {endMsg = iWon ? 'VICTORY' : `${winner} WINS`;}
    deps.fragMessages.show(endMsg);
    sfx.matchHorn(iWon ? 'win' : 'end');
    deps.lazyHud().setScoreboardCountdown?.(15);
    pinScoreboard();
  };
  networkManager.onMatchEnd = (winner, scores): void => {
    const iWon = winner === deps.world.localTeam;
    chat.add(null, winner === 'draw'
      ? `DRAW ${scores.alpha}:${scores.bravo} — time's up, new match starting`
      : `${winner.toUpperCase()} WINS ${scores.alpha}:${scores.bravo} — new match starting`);
    let endMsg;
    if (winner === 'draw') {endMsg = 'DRAW';}
    else {endMsg = iWon ? 'VICTORY' : `${winner.toUpperCase()} WINS`;}
    deps.fragMessages.show(endMsg);
    sfx.matchHorn(iWon ? 'win' : 'end');
    deps.lazyHud().setScoreboardCountdown?.(15);
    pinScoreboard();
  };
  // Signed result receipt → the in-progress recording. The demo's
  // SECTION_TOKEN trailer then carries demo+receipt as one artifact.
  networkManager.onMatchToken = (token): void => {
    const dm = deps.lazyDemoManager?.();
    if (dm?.recorder.isRecording) {dm.recorder.matchToken = token;}
  };
  networkManager.onMatchStart = (mode): void => {
    deps.lazyHud().setScoreboardCountdown?.(null);
    releaseScoreboard();
    // endCleanup reset the flags to 'home' just before this broadcast —
    // the next flagUpdate's →home transitions are a reset, not a play.
    deps.world.flagHomeHush = true;
    // New match = new life record — a streak banked last round must not
    // roll over or the first frag of the round reads as a spree.
    deps.world.killStreak = 0;
    // Fresh score feed too — a carried-over milestone would swallow the
    // new match's first lead line.
    lastLead = '';
    lastMilestone = -1;
    // Server cleared its ffaScores in startNext — the delta path means no
    // full-board echo arrives to wipe ours, so clear it here or last
    // match's rows linger forever.
    deps.world.ffaScores.clear();
    // Same wipe for the frag/death tallies - they ride kill-edge deltas
    // with no snapshot echo, so last match's columns persist without it.
    deps.world.killCounts.clear();
    deps.world.deathCounts.clear();
    chat.add(null, `match start — ${mode || 'arena'}`);
    sfx.matchHorn('start');
  };
  networkManager.onMatchNotice = (text, meta): HTMLDivElement => {
    // Announced kills get the UT booth treatment: the clip plays for the
    // whole room, but the center slab is only for YOUR chain — someone
    // else's spree is a readout, not a banner in your face.
    const mine = meta?.actor === nm().getLocalPlayerId();
    if (mine && (meta?.multi ?? 0) >= 2) {
      const banner = MULTI_BANNER[meta!.multi!] ?? `${meta!.multi}x MULTI KILL`;
      deps.fragMessages.stackKill(banner);
      speakAnnounce(banner, multiClip(meta!.multi!));
    } else if (meta?.ann && ANNOUNCE[meta.ann]) {
      const a = ANNOUNCE[meta.ann]!;
      speakAnnounce(a.banner, a.clip);
      if (mine) {deps.fragMessages.stackKill(a.banner);}
    }
    return chat.add(null, text);
  };
  networkManager.onServerWarn = (text): void => {
    deps.lazyHud().serverWarn(text);
    chat.add(null, text);
  };
}
