// Team rules for Nugget Wars - shared so the client and the Bun server
// agree on the mode's constants and score math. A "team" is just an id;
// membership lives wherever the authority is (server roster online,
// local manager offline).

export type TeamId = 'alpha' | 'bravo';

export const TEAMS: TeamId[] = ['alpha', 'bravo'];

/** First team to bank this many nuggets wins. */
export const WIN_NUGGETS = 100;

/** Team colors - name tags, indicators, scoreboard. */
export const TEAM_COLORS: Record<TeamId, number> = {
  alpha: 0x55_AA_FF, // blue
  bravo: 0xFF_88_55, // orange
};

export const TEAM_LABEL: Record<TeamId, string> = { alpha: 'ALPHA', bravo: 'BRAVO' };

/** Players alternate onto the smaller team - deterministic given a join order. */
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
  if (s.alpha >= winAt) {return 'alpha';}
  if (s.bravo >= winAt) {return 'bravo';}
  return null;
}

/** CTF personal score (the PTS column) - team bank still wins the match;
 *  these credit individual objective work. Shared so the offline CTF sim
 *  pays identical amounts. */
export const CTF_PTS = { kill: 1, flagZoneKill: 2, cap: 10, flagReturn: 3, dmg: 1 } as const;
/** Post-mitigation enemy damage per CTF_PTS.dmg payout - chip and
 *  kills pay the same rate, so pressure is never honor-free. */
export const CTF_DMG_PER_PTS = 100;
/** "Close to a flag" = inside this radius of EITHER stand - defense at
 *  home and escort/offense at the enemy stand both pay the bonus. */
export const CTF_FLAG_ZONE_R = 15;

// ---- Game modes ----
export type ModeId = 'nuggets' | 'ctf' | 'dm' | 'tdm' | 'rabbit' | 'duel' | 'flagrun' | 'conquest' | 'headhunt';

export interface ModeSpec {
  /** HUD label + feed wording. */
  label: string;
  /** Team-based (alpha/bravo) or free-for-all. */
  teams: boolean;
  /** Bots spawn in FFA get their own pseudo-team each. */
  ffa: boolean;
  /** Flag capture mode. */
  flags: boolean;
  /** Gems bank a team point on touch - nuggets-only: in CTF a gem heals
   *  and pays a belt charge but never moves the flag score. */
  gems: boolean;
  /** Score that ends the match (nuggets banked, flag captures, or DM pts). */
  winAt: number;
  /** Match clock seconds - leader wins at the horn, tie = draw. Without
   *  this a stalled match runs forever. */
  timeLimitS: number;
  /** DM scoring - a frag on a real player/bot vs a creature. */
  ptsPlayerKill: number;
  ptsCreatureKill: number;
  /** Frags are the ranking axis (dm/tdm/duel) - scoreboard columns and
   *  PTS-empty behavior read this, not a separate mode set. */
  fragRanked?: boolean;
  /** 'empty' skips the ambient world sims (balls/crawl/pickups/deploy/
   *  influence) - the duel room runs move+proj+health only. Absent =
   *  the full simulated world. */
  world?: 'empty';
}

export const MODES: Record<ModeId, ModeSpec> = {
  nuggets: { label: 'NUGGET WARS', teams: true, ffa: false, flags: false, gems: true, winAt: WIN_NUGGETS, timeLimitS: 900, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  ctf:     { label: 'CAPTURE THE FLAG', teams: true, ffa: false, flags: true, gems: false, winAt: 5, timeLimitS: 1200, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  dm:      { label: 'DEATHMATCH', teams: false, ffa: true, flags: false, gems: false, winAt: 100, timeLimitS: 600, ptsPlayerKill: 10, ptsCreatureKill: 1, fragRanked: true },
  tdm:     { label: 'TEAM DEATHMATCH', teams: true, ffa: false, flags: false, gems: false, winAt: 100, timeLimitS: 900, ptsPlayerKill: 1, ptsCreatureKill: 0, fragRanked: true },
  // Rabbit: FFA around ONE neutral flag - the carrier is the only legal
  // target, hold time pays a point a second, kills pay one each.
  rabbit:  { label: 'RABBIT', teams: false, ffa: true, flags: true, gems: false, winAt: 60, timeLimitS: 900, ptsPlayerKill: 1, ptsCreatureKill: 0 },
  duel:    { label: 'DUEL', teams: false, ffa: true, flags: false, gems: false, winAt: 10, timeLimitS: 300, ptsPlayerKill: 1, ptsCreatureKill: 0, world: 'empty', fragRanked: true },
  // Flag Run: solo cap circuit - a square of stands alternating teams,
  // two flags a side; bank any enemy flag at either friendly stand.
  flagrun: { label: 'FLAG RUN', teams: true, ffa: false, flags: true, gems: false, winAt: 10, timeLimitS: 1800, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  // Conquest (UT-Onslaught lattice): node count IS the scoreboard - the
  // winAt ceiling is unreachable by points so the horn resolves on nodes
  // held; a dead enemy core ends it early via endMatch.
  conquest: { label: 'CONQUEST', teams: true, ffa: false, flags: false, gems: false, winAt: 999, timeLimitS: 1200, ptsPlayerKill: 0, ptsCreatureKill: 0 },
  // Headhunt: tokens are held, never banked - the team score is the live
  // sum of tokens carried, so it moves on every grab AND every carrier
  // death. Nothing to reach, so the horn resolves on whoever holds more.
  headhunt: { label: 'HEADHUNT', teams: true, ffa: false, flags: false, gems: false, winAt: 100, timeLimitS: 900, ptsPlayerKill: 0, ptsCreatureKill: 0 },
};

/** Flag carry rules - shared client/server. */
export const FLAG_PICKUP_R = 6;     // touch distance to grab/return a flag - generous enough for a 40m/s ski-pass graze
/** Speed-scaled touch bonus (m): a fast swept pass has no lateral
 *  correction left - skiing is frictionless and air control is
 *  magnitude-preserving, so by the ring the trajectory is committed.
 *  The bonus only pays for speed: walk-in grabs keep the honest base
 *  ring; a 50m/s graze earns ~+6m of planar tolerance (cap +8). Add to
 *  the perk-scaled radius at every touch check - all grab paths must
 *  agree. */
export function flagTouchBonus(speedH: number): number {
  return Math.min(8, Math.max(0, (speedH - 25) * 0.25));
}
export const FLAG_HOME_R = 8;       // capture ring around own base
export const FLAG_RESET_S = 20;     // dropped flag returns home after this
