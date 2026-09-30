/**
 * shared/flagGoals.ts — CTF role policy, ONE implementation for both bot
 * runtimes. ServerBots (online) and CtfFlags (offline) previously each
 * hand-synced a copy of "who chases the thief, who plants on the stand";
 * drift between them meant bots played different CTF by host.
 *
 * Positions flow in as plain {x,y,z} snapshots so neither runtime's flag
 * or player plumbing leaks into the rule table.
 */

export type BotRole =
  | 'capper'      // flag route is the job — press/escort
  | 'offense'     // light offense — clear the stand for the capper
  | 'ldefense'    // light defense — sits home, chases the thief
  | 'hof'         // heavy on flag — planted, never pursues
  | 'defense'     // generic home-side defender
  | 'technician'  // deploy kit at home (server-side role — needs deploys)
  | 'infiltrator' // slips in cloaked (server-side role — needs the intent bit)
  ;

export interface FlagSituation {
  /** Own team's flag stand — the homeward target. */
  home: { x: number; y: number; z: number };
  /** Enemy carrying OUR flag — position is legal (tickUpdate streams it,
   *  chasing the thief is not a wallhack). */
  thief: { x: number; y: number; z: number } | null;
  /** Our flag lying in the field — touch sends it home. */
  dropped: { x: number; y: number; z: number } | null;
  /** Enemy flag when it's grabbable (not already carried by a teammate). */
  enemyStand: { x: number; y: number; z: number } | null;
  /** A teammate carrying the enemy flag — escort target. */
  escort: { x: number; y: number; z: number } | null;
}

/** Role-priority table, core before luxury — the row unlocks when the
 *  squad reaches minSquad bodies, so small squads fill capping and
 *  chasing before anyone specializes. Both runtimes filter to the roles
 *  their bots can actually play (offline has no deploy/cloak intent). */
export const ROLE_PRIORITY: { role: BotRole; want: number; minSquad: number }[] = [
  { role: 'capper', want: 1, minSquad: 3 },
  { role: 'ldefense', want: 1, minSquad: 4 },
  { role: 'hof', want: 1, minSquad: 5 },
  { role: 'technician', want: 1, minSquad: 6 },
  { role: 'infiltrator', want: 1, minSquad: 7 },
];

/** Where a role should run given the current flag situation. Returns the
 *  situation slot picked — callers compare against their own slots (e.g.
 *  `result === s.enemyStand` ⇒ the bot is pressing the stand, which the
 *  server reads as its infiltrate/cloak intent). */
export function roleObjective(role: string, s: FlagSituation): { x: number; y: number; z: number } {
  switch (role) {
    case 'hof': return hofGoal(s);
    case 'ldefense': case 'technician': case 'defense': return defenseGoal(s);
    case 'capper': return capperGoal(s);
    case 'infiltrator': return infiltratorGoal(s);
    default: return offenseGoal(s);
  }
}

/** HoF: planted on the stand, PERIOD — never chases a thief (that's what
 *  LD exists for). Only leaves the ring for a flag dropped in easy reach. */
function hofGoal(s: FlagSituation) {
  if (s.dropped && Math.hypot(s.dropped.x - s.home.x, s.dropped.z - s.home.z) < 25) return s.dropped;
  return s.home;
}

/** Light defense / technician / generic defense: home-side priorities —
 *  thief, dropped, then hold home in intercept range. */
function defenseGoal(s: FlagSituation) {
  if (s.thief) return s.thief;
  if (s.dropped) return s.dropped;
  return s.home;
}

/** Capper: the flag route is the job — escort a carrier teammate,
 *  otherwise press the stand. Only a dropped own flag pulls it off-route. */
function capperGoal(s: FlagSituation) {
  if (s.escort) return s.escort;
  if (s.dropped) return s.dropped;
  if (s.enemyStand) return s.enemyStand;
  return s.home;
}

/** Infiltrator: slips in to wreck gear / grab — the stand press holds
 *  even when nobody's home so the cloak keeps covering the breach. */
function infiltratorGoal(s: FlagSituation) {
  if (s.escort) return s.escort;
  if (s.enemyStand) return s.enemyStand;
  if (s.thief) return s.thief;
  return s.home;
}

/** Offense (light offense in Tribes terms): escort a carrier, punish a
 *  thief, else press the enemy stand to clear it for the capper. */
function offenseGoal(s: FlagSituation) {
  if (s.escort) return s.escort;
  if (s.thief) return s.thief;
  if (s.dropped) return s.dropped;
  if (s.enemyStand) return s.enemyStand;
  return s.home; // flag's moving — defend home
}
