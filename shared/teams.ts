// Team rules for Nugget Wars — shared so the client and the Bun server
// agree on the mode's constants and score math. A "team" is just an id;
// membership lives wherever the authority is (server roster online,
// local manager offline).

export type TeamId = 'alpha' | 'bravo';

export const TEAMS: TeamId[] = ['alpha', 'bravo'];

/** First team to bank this many nuggets wins. */
export const WIN_NUGGETS = 100;

/** Team colors — name tags, indicators, scoreboard. */
export const TEAM_COLORS: Record<TeamId, number> = {
  alpha: 0x55aaff, // blue
  bravo: 0xff8855, // orange
};

export const TEAM_LABEL: Record<TeamId, string> = { alpha: 'ALPHA', bravo: 'BRAVO' };

/** Players alternate onto the smaller team — deterministic given a join order. */
export function pickTeam(existingCounts: Record<TeamId, number>): TeamId {
  return existingCounts.alpha <= existingCounts.bravo ? 'alpha' : 'bravo';
}

export interface TeamScores {
  alpha: number;
  bravo: number;
}

export function makeScores(): TeamScores { return { alpha: 0, bravo: 0 }; }

/** Bank n nuggets for a team; returns the new total. */
export function bank(s: TeamScores, team: TeamId, n = 1): number {
  s[team] += n;
  return s[team];
}

/** First team at/over the win threshold, or null. */
export function winner(s: TeamScores): TeamId | null {
  if (s.alpha >= WIN_NUGGETS) return 'alpha';
  if (s.bravo >= WIN_NUGGETS) return 'bravo';
  return null;
}
