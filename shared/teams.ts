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
export function winner(s: TeamScores, winAt = WIN_NUGGETS): TeamId | null {
  if (s.alpha >= winAt) return 'alpha';
  if (s.bravo >= winAt) return 'bravo';
  return null;
}

// ---- Game modes ----
export type ModeId = 'nuggets' | 'ctf' | 'dm' | 'tdm';

export interface ModeSpec {
  /** HUD label + feed wording. */
  label: string;
  /** Team-based (alpha/bravo) or free-for-all. */
  teams: boolean;
  /** Bots spawn in FFA get their own pseudo-team each. */
  ffa: boolean;
  /** Flag capture mode. */
  flags: boolean;
  /** Score that ends the match (nuggets banked, flag captures, or DM pts). */
  winAt: number;
  /** Match clock seconds — leader wins at the horn, tie = draw. Without
   *  this a stalled match runs forever. */
  timeLimitS: number;
  /** DM scoring — a frag on a real player/bot vs a creature. */
  ptsPlayerKill: number;
  ptsCreatureKill: number;
}

export const MODES: Record<ModeId, ModeSpec> = {
  nuggets: { label: 'NUGGET WARS', teams: true, ffa: false, flags: false, winAt: WIN_NUGGETS, timeLimitS: 900, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  ctf:     { label: 'CAPTURE THE FLAG', teams: true, ffa: false, flags: true, winAt: 5, timeLimitS: 1200, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  dm:      { label: 'DEATHMATCH', teams: false, ffa: true, flags: false, winAt: 100, timeLimitS: 600, ptsPlayerKill: 10, ptsCreatureKill: 1 },
  tdm:     { label: 'TEAM DEATHMATCH', teams: true, ffa: false, flags: false, winAt: 100, timeLimitS: 900, ptsPlayerKill: 1, ptsCreatureKill: 0 },
};

/** Flag carry rules — shared client/server. */
export const FLAG_PICKUP_R = 2.2;   // touch distance to grab/return a flag
export const FLAG_HOME_R = 8;       // capture ring around own base
export const FLAG_RESET_S = 20;     // dropped flag returns home after this
