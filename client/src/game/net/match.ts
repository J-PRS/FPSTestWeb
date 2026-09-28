// Match lifecycle + score events — all chat-facing announcements live here.

import type { NetCtx } from './ctx.js';

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
  networkManager.onFfaMatchEnd = (winner, scores) =>
    chat.add(null, winner === 'draw'
      ? 'DRAW — time\'s up, new match starting'
      : `${winner} WINS the deathmatch — ${scores[winner]} pts — new match starting`);
  networkManager.onMatchEnd = (winner, scores) =>
    chat.add(null, winner === 'draw'
      ? `DRAW ${scores.alpha}:${scores.bravo} — time's up, new match starting`
      : `${winner.toUpperCase()} WINS ${scores.alpha}:${scores.bravo} — new match starting`);
  networkManager.onMatchStart = (mode) =>
    chat.add(null, `match start — ${mode || 'arena'}`);
  networkManager.onMatchNotice = (text) => chat.add(null, text);
}
