// Match lifecycle + score events — chat announcements plus the center
// banner + horn stinger on match boundaries.

import type { NetCtx } from './ctx.js';
import * as sfx from '../../core/sfx.js';
import { MODES, type ModeId } from '../../../../shared/teams.js';

export function wireMatchEvents(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  // End-of-match standings: pin the scoreboard at the horn unless the
  // player already had it open — auto-shown means auto-dismissed at the
  // next matchStart, so a deliberate Tab is never hijacked.
  let sbAutoShown = false;
  const pinScoreboard = (): void => {
    const hud = deps.lazyHud();
    if (hud.scoreboardVisible) return;
    hud.setScoreboardVisible(true);
    sbAutoShown = true;
  };
  const releaseScoreboard = (): void => {
    if (!sbAutoShown) return;
    sbAutoShown = false;
    deps.lazyHud().setScoreboardVisible(false);
  };

  // Score-spam filter: teamScore broadcasts on EVERY scoring event — in
  // nuggets that's one line per gem banked, and the feed drowns. Announce
  // only lead changes, every 10-pt milestone, and the endgame stretch
  // (within 10 of the cap) where each point actually matters.
  let lastLead = '';
  let lastMilestone = -1;
  networkManager.onTeamScore = (scores, winAt) => {
    if (!Number.isFinite(scores.alpha + scores.bravo + winAt)) return;
    deps.world.teamScores = scores;
    deps.lazyHud().setTeamScore?.(scores.alpha, scores.bravo);
    const top = Math.max(scores.alpha, scores.bravo);
    const lead = scores.alpha === scores.bravo ? 'tie' : scores.alpha > scores.bravo ? 'alpha' : 'bravo';
    const milestone = Math.floor(top / 10);
    if (lead !== lastLead || milestone > lastMilestone || top >= winAt - 10) {
      chat.add(null, `ALPHA ${scores.alpha} : ${scores.bravo} BRAVO  (first to ${winAt})`);
      lastLead = lead;
      lastMilestone = milestone;
    }
  };
  networkManager.onFfaScore = (scores, winAt) => {
    if (Object.values(scores).some(v => !Number.isFinite(v)) || !Number.isFinite(winAt)) return;
    deps.world.ffaScores = new Map(Object.entries(scores));
    const me = nm().getLocalPlayerId();
    const mine = scores[me] ?? 0;
    let lead = 0; for (const v of Object.values(scores)) if (v > lead) lead = v;
    // Only announce when the lead changes hands or YOU score — a per-kill
    // feed line for every bot frag would drown the chat. Team modes reuse
    // the same channel for the personal PTS column — silent there, the
    // win is the team bank, not a personal race to winAt.
    if (MODES[deps.world.mode as ModeId]?.ffa && (scores[me] ?? 0) > 0) {
      chat.add(null, `you: ${mine} pts (leader ${lead}/${winAt})`);
    }
  };
  networkManager.onFfaMatchEnd = (winner, scores) => {
    const me = nm().getLocalPlayerId();
    const iWon = winner === me;
    chat.add(null, winner === 'draw'
      ? 'DRAW — time\'s up, new match starting'
      : `${winner} WINS the deathmatch — ${scores[winner]} pts — new match starting`);
    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : `${winner} WINS`);
    sfx.matchHorn(iWon ? 'win' : 'end');
    deps.lazyHud().setScoreboardCountdown?.(10);
    pinScoreboard();
  };
  networkManager.onMatchEnd = (winner, scores) => {
    const iWon = winner === deps.world.localTeam;
    chat.add(null, winner === 'draw'
      ? `DRAW ${scores.alpha}:${scores.bravo} — time's up, new match starting`
      : `${winner.toUpperCase()} WINS ${scores.alpha}:${scores.bravo} — new match starting`);
    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : `${winner.toUpperCase()} WINS`);
    sfx.matchHorn(iWon ? 'win' : 'end');
    deps.lazyHud().setScoreboardCountdown?.(10);
    pinScoreboard();
  };
  networkManager.onMatchStart = (mode) => {
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
    chat.add(null, `match start — ${mode || 'arena'}`);
    sfx.matchHorn('start');
  };
  networkManager.onMatchNotice = (text) => chat.add(null, text);
  networkManager.onServerWarn = (text) => {
    deps.lazyHud().serverWarn(text);
    chat.add(null, text);
  };
}
