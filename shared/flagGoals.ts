/**
 * shared/flagGoals.ts — CTF role policy, ONE implementation for both bot
 * runtimes. ServerBots (online) and CtfFlags (offline) previously each
 * hand-synced a copy of "who chases the thief, who plants on the stand";
 * drift between them meant bots played different CTF by host.
 *
 * Positions flow in as plain {x,y,z} snapshots so neither runtime's flag
 * or player plumbing leaks into the rule table.
 */

import { botRand } from './botRand.ts';
import { BOT_TUNING } from './botTuning.ts';

export type BotRole =
  | 'capper'      // flag route is the job — press/escort
  | 'offense'     // light offense — clear the stand for the capper
  | 'ldefense'    // light defense — sits home, chases the thief
  | 'hof'         // heavy on flag — planted, never pursues
  | 'defense'     // generic home-side defender
  | 'technician'  // deploy kit at home (server-side role — needs deploys)
  | 'infiltrator' // slips in cloaked (server-side role — needs the intent bit)
  | 'bombardier'  // stand-clearer — shells the enemy stand from mortar range
  | 'medic'       // heal kit — shadows the push, patches the pack
  ;

export interface FlagSituation {
  /** Own team's flag stand — the homeward target. */
  home: { x: number; y: number; z: number };
  /** Enemy carrying OUR flag — position is legal (tickUpdate streams it,
   *  chasing the thief is not a wallhack). */
  /** Own flag's carrier — velocity rides along like the escort slot so
   *  chasers intercept the run, not the wake. */
  thief: { x: number; y: number; z: number; vx?: number; vz?: number } | null;
  /** Our flag lying in the field — touch sends it home. */
  dropped: { x: number; y: number; z: number } | null;
  /** Enemy flag when it's grabbable (not already carried by a teammate). */
  enemyStand: { x: number; y: number; z: number } | null;
  /** A teammate carrying the enemy flag — escort target. Velocity
   *  rides along so escorts intercept where he'll be, not where he is. */
  escort: { x: number; y: number; z: number; vx?: number; vz?: number } | null;
  /** Nearest enemy pressing OUR stand — the HoF's body-block anchor.
   *  Only populated for hostiles inside the home ring's reach. */
  threat: { x: number; y: number; z: number } | null;
  /** A teammate capper is seconds from the enemy stand — the squad
   *  floods ahead of it: attackers clear defenders, shellers lob.
   *  Carries the stand pos so a push can be joined from anywhere. */
  push?: { x: number; y: number; z: number } | null;
  /** The deciding bot's own position — populated when a goal needs
   *  "can I get there first" rather than pure priority (the llama
   *  deny-grab). */
  me?: { x: number; z: number } | null;
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
  { role: 'bombardier', want: 1, minSquad: 6 },
  // Medic before infiltrator at the same unlock — a healer lifts every
  // push; the cloak is the more situational luxury.
  { role: 'medic', want: 1, minSquad: 7 },
  { role: 'infiltrator', want: 1, minSquad: 7 },
  // Second runner once the squad can afford it — a lone capper dying
  // mid-route leaves the stand attack dead until respawn, and real
  // CTF runs shifts of cappers anyway. Luxury slot: last so the core
  // defenders fill first; incremental want:1 → 2 cappers total.
  { role: 'capper', want: 1, minSquad: 7 },
];

/** Roles a wire-side bot can actually play — no deploy kit and no
 *  cloak intent on that runtime, so technician/infiltrator stay
 *  server-side. */
export const WIRE_ROLES: BotRole[] = ['capper', 'ldefense', 'hof', 'defense', 'offense', 'bombardier'];

/** Strict-tier roles — the only slots that re-fit a donor's body.
 *  HoF is literally "heavy on flag" and the technician carries the
 *  deploy kit; the runners (capper/infiltrator) fly light because the
 *  role IS speed. Offense/defense take whatever class shows up — a
 *  heavy anchor pushing offense and a light harasser defending are
 *  both legitimate, so generic slots never re-fit. Shared so the
 *  offline lobby applies the same re-fit the server roster does —
 *  a medium skin on a heavy sim is how the class lie starts. */
export const STRICT_CLASS: Partial<Record<BotRole, 'light' | 'medium' | 'heavy'>> = {
  capper: 'light', infiltrator: 'light',
  hof: 'heavy', technician: 'heavy',
};

/** Kit → role fitness. A guideline, not a lock: offense/defense accept
 *  every class (heavy offense and light harassers are both classic), the
 *  runners (capper/infiltrator) pull light, and the planted specialists
 *  (hof/technician) pull heavy hard — HoF IS "heavy on flag". */
export const CLASS_FITNESS: Record<string, Record<BotRole, number>> = {
  light:   { capper: 3,   infiltrator: 3,   ldefense: 2,   offense: 1.5, defense: 1,   technician: 0.4, hof: 0.2, bombardier: 0.3, medic: 1.5 },
  medium:  { offense: 3,  defense: 2.5,     ldefense: 2,   capper: 1.2,  hof: 1,       infiltrator: 1,  technician: 1,  bombardier: 1.5, medic: 2.5 },
  heavy:   { hof: 3,      technician: 2.5,  defense: 2,    offense: 2,   ldefense: 1,  capper: 0.4,     infiltrator: 0.4, bombardier: 3,   medic: 1 },
};
const fit = (cls: string | undefined, role: BotRole): number =>
  (cls ? CLASS_FITNESS[cls]?.[role] : undefined) ?? 1.5;

/** Deterministic squad assignment: every peer sorts the same roster and
 *  walks the same fill order, so each bot computes the team's layout
 *  locally and lands on its own slot — squad coordination with zero
 *  coordinator messages. Specialist slots go to the best-fit kit
 *  (CLASS_FITNESS argmax, id tiebreak — class is a pull, not a gate);
 *  the tail fills offense/defense alternately, open to any class. */
export function assignRole(
  myId: string,
  teammateIds: string[],
  playable: BotRole[] = WIRE_ROLES,
  kitOf?: (id: string) => string | undefined,
): BotRole {
  const ids = [...teammateIds].sort();
  const me = ids.indexOf(myId);
  if (me === -1) {return 'offense';}
  const mine = new Map<string, BotRole>();
  for (const { role, want, minSquad } of ROLE_PRIORITY) {
    if (!playable.includes(role)) {continue;}
    if (ids.length < minSquad) {continue;}
    for (let i = 0; i < want; i += 1) {
      let best: string | null = null;
      let bestFit = -Infinity;
      for (const id of ids) {
        if (mine.has(id)) {continue;}
        const f = fit(kitOf?.(id), role);
        if (f > bestFit) { bestFit = f; best = id; }
      }
      if (!best) {break;}
      mine.set(best, role);
    }
  }
  let tail = 0;
  for (const id of ids) {
    if (mine.has(id)) {continue;}
    mine.set(id, tail % 3 === 2 ? 'defense' : 'offense');
tail += 1;
  }
  return mine.get(myId) ?? 'offense';
}

/** Where a role should run given the current flag situation. Returns the
 *  situation slot picked — callers compare against their own slots (e.g.
 *  `result === s.enemyStand` ⇒ the bot is pressing the stand, which the
 *  server reads as its infiltrate/cloak intent). */
/** Which flank a home-side role takes — derived from the bot id so two
 *  generic defenders mirror each other instead of stacking. */
export function roleSide(id: string): number {
  let h = 0;
  // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point
  for (let i = 0; i < id.length; i += 1) {h = (h * 31 + id.charCodeAt(i)) | 0;}
  return (h & 1) === 0 ? 1 : -1;
}

/** Offense (light offense in Tribes terms): kill the thief first —
 *  while our flag is out the score is blocked anyway, so returning it
 *  beats shadowing a carrier who legally can't cap yet. Then escort,
 *  then press the enemy stand to clear it for the capper. */
function offenseGoal(s: FlagSituation): { x: number; y: number; z: number; } {
  // The llama deny: grabbing THEIR flag removes the cap condition
  // outright while chasing a fast carrier the last stretch is a lost
  // footrace. Urgency is a field, not a cutoff — odds of the deny play
  // rise as their carrier closes on the stand AND as the flag sits
  // reachable; a bot on the flag with the carrier 200m out nearly
  // always takes it, a far bot with the carrier at the lip mostly
  // still chases (he'd never reach the stand in time anyway — the
  // chase is the only play that can still score contact).
  if (s.thief && s.enemyStand && s.me) {
    const thiefToStand = Math.hypot(s.thief.x - s.enemyStand.x, s.thief.z - s.enemyStand.z);
    const meToFlag = Math.hypot(s.me.x - s.enemyStand.x, s.me.z - s.enemyStand.z);
    const capRisk = 1 - Math.min(1, thiefToStand / 300);
    const reach = 1 - Math.min(1, meToFlag / Math.max(60, thiefToStand * 1.5));
    if (botRand() < capRisk * capRisk * reach * reach) {return s.enemyStand;}
  }
  if (s.thief) {return s.thief;}
  // A called push drops routine jobs (escort/dropped read below it):
  // the capper is ~10s out, so offense floods the stand NOW to eat
  // the HoF/defense that would otherwise kill it at the flag.
  if (s.push) {return s.push;}
  if (s.escort) {return s.escort;}
  if (s.dropped) {return s.dropped;}
  if (s.enemyStand) {return s.enemyStand;}
  return s.home; // flag's moving — defend home
}



/** Medic: shadow the push, not lead it — the carrier's pocket first,
 *  then hang ~40m behind whoever presses the stand (close enough to
 *  beam the breachers, far enough to live), a dropped flag pulls like
 *  everyone else's, home otherwise. */
function medicGoal(s: FlagSituation): { x: number; y: number; z: number; } {
  if (s.escort) {return s.escort;}
  if (s.dropped) {return s.dropped;}
  if (s.enemyStand) {
    const dx = s.home.x - s.enemyStand.x, dz = s.home.z - s.enemyStand.z;
    const d = Math.hypot(dx, dz);
    if (d > 1) {
      const back = Math.min(40, d * 0.2);
      return { x: s.enemyStand.x + (dx / d) * back, y: s.enemyStand.y, z: s.enemyStand.z + (dz / d) * back };
    }
    return s.enemyStand;
  }
  return s.home;
}



/** Infiltrator: slips in to wreck gear / grab — the stand press holds
 *  even when nobody's home so the cloak keeps covering the breach. */
function infiltratorGoal(s: FlagSituation): { x: number; y: number; z: number; } {
  if (s.escort) {return s.escort;}
  // The push call outranks a routine stand press — the breach is timed
  // to the capper's arrival, not whenever the saboteur wandered up.
  if (s.push) {return s.push;}
  if (s.enemyStand) {return s.enemyStand;}
  if (s.thief) {return s.thief;}
  return s.home;
}



/** Bombardier: the stand-clearer — holds a shelling perch ~90m off the
 *  enemy stand on the friendly side (mortar/MRV standoff), so the capper
 *  arrives at a softened stand instead of a fortified one. Not on the
 *  flag — parking ON the stand is the capper's death, not the
 *  bombardier's job. Falls back to escort/home when there's no stand
 *  to shell. */
function bombardierGoal(s: FlagSituation): { x: number; y: number; z: number; } {
  if (s.enemyStand) {
    const dx = s.home.x - s.enemyStand.x, dz = s.home.z - s.enemyStand.z;
    const d = Math.hypot(dx, dz);
    if (d > 1) {
      const standoff = Math.min(90, d * 0.35);
      return {
        x: s.enemyStand.x + (dx / d) * standoff,
        y: s.enemyStand.y,
        z: s.enemyStand.z + (dz / d) * standoff,
      };
    }
    return s.enemyStand;
  }
  if (s.escort) {return s.escort;}
  if (s.dropped) {return s.dropped;}
  return s.home;
}



/** Capper: the flag route is the job — escort a carrier teammate,
 *  otherwise press the stand. Only a dropped own flag pulls it off-route. */
function capperGoal(s: FlagSituation): { x: number; y: number; z: number; } {
  if (s.escort) {return s.escort;}
  if (s.dropped) {return s.dropped;}
  if (s.enemyStand) {return s.enemyStand;}
  return s.home;
}



/** Light defense / technician / generic defense: home-side priorities —
 *  thief, dropped, then hold home in intercept range. A teammate
 *  carrier closing on home pulls midfield defense OUT to meet him —
 *  early escort beats a late body-block: the carrier's most fragile
 *  leg is the approach, where chasers converge. */
function defenseGoal(s: FlagSituation, role: string, side: number): { x: number; y: number; z: number; } {
  if (s.thief) {return s.thief;}
  if (s.dropped) {return s.dropped;}
  if (s.escort && Math.hypot(s.escort.x - s.home.x, s.escort.z - s.home.z) < 260) {return s.escort;}
  // Idle: don't stack bodies on the pole — the era's real defense is
  // coverage, not a clump. LD screens the incoming lane toward the
  // enemy stand, generic defense takes a flank (side mirrors per bot),
  // technician stays on the pole for the weld/deploy work.
  if (s.enemyStand) {
    const dx = s.enemyStand.x - s.home.x, dz = s.enemyStand.z - s.home.z;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d;
    if (role === 'ldefense') {return { x: s.home.x + ux * 38, y: s.home.y, z: s.home.z + uz * 38 };}
    if (role === 'defense') {return { x: s.home.x - uz * side * 24 + ux * 10, y: s.home.y, z: s.home.z + ux * side * 24 + uz * 10 };}
  }
  return s.home;
}



/** HoF: planted on the stand, PERIOD — never chases a thief (that's what
 *  LD exists for). Only leaves the ring for a flag dropped in easy
 *  reach. With a threat inbound it interposes — plants a few meters
 *  toward the incoming line so a capping run hits a heavy's hitbox
 *  before it hits the flag. */
function hofGoal(s: FlagSituation, commit: number): { x: number; y: number; z: number; } {
  const T = BOT_TUNING.hof;
  if (s.dropped && Math.hypot(s.dropped.x - s.home.x, s.dropped.z - s.home.z) < T.dropR) {return s.dropped;}
  if (s.threat) {
    const dx = s.threat.x - s.home.x, dz = s.threat.z - s.home.z;
    const d = Math.hypot(dx, dz);
    if (d > 1 && d < T.threatR) {
      // The HoF body-block: slide onto the capper's run line so his
      // speed meets a heavy's hitbox before it meets the flag. A slack
      // HoF barely shifts off the pole, a locked-in one squares up
      // several meters into the lane.
      const lean = Math.min(T.leanMax, d * T.leanK) * commit;
      return { x: s.home.x + (dx / d) * lean, y: s.home.y, z: s.home.z + (dz / d) * lean };
    }
  }
  return s.home;
}



export function roleObjective(role: string, s: FlagSituation, commit = 1, side = 1): { x: number; y: number; z: number } {
  // Mutual-carry lock: both flags are out, so nobody can cap and the match
  // is decided by which carrier dies first. If every role kept its routine
  // job, chasers would trickle in one at a time against a stand-camped
  // carrier plus its whole defense — the 8v8 zero-cap deadlock. Folding
  // every non-anchor role onto the enemy carrier turns the trickle into a
  // mass push. HoF holds (the parked carrier is still a stand to guard)
  // and the capper stays escort (our carrier needs a screen, not a crowd
  // of identical chasers — the escort keeps moving while the mob hunts).
  if (s.thief && s.escort && role !== 'hof' && role !== 'capper') {return s.thief;}
  switch (role) {
    case 'hof': { return hofGoal(s, commit);
    }
    case 'ldefense': case 'technician': case 'defense': { return defenseGoal(s, role, side);}
    case 'capper': { return capperGoal(s);
    }
    case 'bombardier': { return bombardierGoal(s);
    }
    case 'infiltrator': { return infiltratorGoal(s);
    }
    case 'medic': { return medicGoal(s);
    }
    default: { return offenseGoal(s);
    }
  }
}
