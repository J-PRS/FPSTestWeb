// Match lifecycle + score events — chat announcements plus the center
// banner + horn stinger on match boundaries.

import type { NetCtx } from './ctx.js';
import * as sfx from '../../core/sfx.js';

export function wireMatchEvents(ctx: NetCtx): void {
  const { deps, networkManager, chat, nm } = ctx;

  networkManager.onTeamScore = (scores, winAt) => {
    deps.world.teamScores = scores;
    deps.lazyHud().setTeamScore?.(scores.alpha, scores.bravo);
    chat.add(null, `ALPHA ${scores.alpha} : ${scores.bravo} BRAVO  (first to ${winAt})`);
  };
  networkManager.onFfaScore = (scores, winAt) => {
    deps.world.ffaScores = new Map(Object.entries(scores));
    const me = nm().getLocalPlayerId();
    const mine = scores[me] ?? 0;
    let lead = 0; for (const v of Object.values(scores)) if (v > lead) lead = v;
    // Only announce when the lead changes hands or YOU score — a per-kill
    // feed line for every bot frag would drown the chat.
    if ((scores[me] ?? 0) > 0) chat.add(null, `you: ${mine} pts (leader ${lead}/${winAt})`);
  };
  networkManager.onFfaMatchEnd = (winner, scores) => {
    const me = nm().getLocalPlayerId();
    const iWon = winner === me;
    chat.add(null, winner === 'draw'
      ? 'DRAW — time\'s up, new match starting'
      : `${winner} WINS the deathmatch — ${scores[winner]} pts — new match starting`);
    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : `${winner} WINS`);
    sfx.matchHorn(iWon ? 'win' : 'end');
  };
  networkManager.onMatchEnd = (winner, scores) => {
    const iWon = winner === deps.world.localTeam;
    chat.add(null, winner === 'draw'
      ? `DRAW ${scores.alpha}:${scores.bravo} — time's up, new match starting`
      : `${winner.toUpperCase()} WINS ${scores.alpha}:${scores.bravo} — new match starting`);
    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : `${winner.toUpperCase()} WINS`);
    sfx.matchHorn(iWon ? 'win' : 'end');
  };
  networkManager.onMatchStart = (mode) => {
    chat.add(null, `match start — ${mode || 'arena'}`);
    sfx.matchHorn('start');
  };
  networkManager.onMatchNotice = (text) => chat.add(null, text);
}
