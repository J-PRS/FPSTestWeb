import { mkRoom, step, watch } from './harness.ts';
import { simNow } from '../../src/simClock.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';
import { ROLE_PRIORITY, STRICT_CLASS, type BotRole } from '../../../shared/flagGoals.ts';
import type { BotLoadout } from '../../../shared/botLoadouts.ts';
import type { PerkId } from '../../../shared/perks.ts';

// Defense telemetry, parameterized: a REAL 8v8 CTF match on a real field —
// nobody is quiet, so the HoF score includes surviving offense clears,
// re-posting under fire, and the midfield war stealing his attention.
// _tools/sweeps/hofSweep perturbs BOT_TUNING and reads these columns.
export interface DefStat {
  grabs: number;        // enemy flag pickups, both teams
  caps: number;         // enemy caps conceded, both teams
  drops: number;        // carriers dropped mid-route
  returns: number;      // dropped-flag returns home
  medHold: number;      // median carrier hold time (s) — short = defense kills fast
  awayS: number;        // sim-seconds any flag sat not-home
  hofKills: number;     // kills dealt by hof-role bots
  hofDeaths: number;    // deaths of hof-role bots
  kills: number;        // all kills (team lethality sanity)
  scoreA: number;
  scoreB: number;
}

export interface DefMeasureOpts {
  simBudgetS?: number;
  seed?: number;
  tag?: string;
  /** Base-level genome: the HoF's whole archetype — kit, perk, builder
   *  trait. Applied to whichever bot the roster names 'hof' each second
   *  (rebalance re-stamps perk/builder, so this re-asserts). STRICT_CLASS
   *  for hof is lifted for the run so a non-heavy kit keeps its body —
   *  the class gene is implicit in the weapon picks (mortar ⇒ heavy,
   *  lightning ⇒ light). */
  hofSpec?: { perk: PerkId; kit: BotLoadout; builder: boolean };
  /** Capper slots per team for the run — more runners = more flag events
   *  per match-minute (more signal per wall-second), and the missing
   *  bodies in other roles is the exact pressure a real HoF faces. */
  capperWant?: number;
}

/** Run one full-bot CTF match and return the defense-quality columns. */
export function measureDefense(
  fld: Heightfield,
  bases: { alpha: { x: number; y: number; z: number }; bravo: { x: number; y: number; z: number } },
  spec: Record<string, unknown>,
  opts: DefMeasureOpts = {},
): DefStat {
  const simBudgetS = opts.simBudgetS ?? 360;
  // botFill must match bots — map specs ship a lower floor (10) that would
  // retire the populate down to 5v5 and strip the hof slot being measured.
  const room = mkRoom({ ...spec, mode: 'ctf', bots: 16, botFill: 16, bases }, 'ctf', opts.seed ?? 9001, false, fld);
  let clock = 0;
  const w = watch(room, () => clock);
  const ctl = room.bots as unknown as {
    roster: { roleInfo: Map<string, BotRole>; refitClass(id: string): void };
    loadouts: Map<string, BotLoadout>;
    brains: Map<string, { setBuilder(v: boolean): void }>;
  };
  const roles = ctl.roster.roleInfo;
  // A swept kit picks its own class — lift the hof strict refit so the
  // roster doesn't snap every hof back to heavy+mortar each 5s cycle.
  const hadStrict = 'hof' in STRICT_CLASS;
  if (opts.hofSpec) delete STRICT_CLASS.hof;
  const capRow = ROLE_PRIORITY.find((r) => r.role === 'capper')!;
  const prevCap = capRow.want;
  if (opts.capperWant !== undefined) capRow.want = opts.capperWant;
  const enforceHofSpec = () => {
    const g = opts.hofSpec;
    if (!g) return;
    for (const [id, role] of roles) {
      if (role !== 'hof') continue;
      const lo = ctl.loadouts.get(id);
      if (lo && (lo.perk !== g.kit.perk || lo.near !== g.kit.near || lo.mid !== g.kit.mid
        || lo.far !== g.kit.far || lo.belt !== g.kit.belt)) {
        ctl.loadouts.set(id, { ...g.kit });
        ctl.roster.refitClass(id);
      }
      const p = room.players.getPlayer(id);
      if (p && p.perk !== g.perk) p.perk = g.perk;
      ctl.brains.get(id)?.setBuilder(g.builder);
    }
  };

  const dt = 0.05;
  const t0 = Date.now();
  const wallBudget = simBudgetS * 900;
  let awayTicks = 0;
  try {
    for (let i = 0; i < simBudgetS * 20; i++) {
      if (Date.now() - t0 > wallBudget) break;
      step(room, 1, dt);
      room.messages.respawnTick(simNow());
      clock += dt;
      if (i % 20 === 0) enforceHofSpec();
      for (const fl of room.flags?.flags.values() ?? []) {
        if (fl.state !== 'home') awayTicks++;
      }
    }
  } finally {
    if (hadStrict) STRICT_CLASS.hof = 'heavy';
    capRow.want = prevCap;
  }

  // Pair each grab with its outcome — same ledger shape as matchSim.
  const carries: { grabT: number; endT?: number; result: 'cap' | 'drop' | 'held' }[] = [];
  const prev: Record<string, { state: string }> = {};
  let kills = 0, returns = 0, hofKills = 0, hofDeaths = 0;
  for (const m of w.msgs as {
    type: string; _s?: number; shooterId?: string; targetId?: string;
    flags?: { team: string; state: string; carrier: string | null }[];
  }[]) {
    if (m.type === 'playerKill') {
      kills++;
      if (roles.get(m.shooterId ?? '') === 'hof') hofKills++;
      if (roles.get(m.targetId ?? '') === 'hof') hofDeaths++;
      continue;
    }
    if (m.type !== 'flagUpdate') continue;
    for (const fl of m.flags ?? []) {
      const was = prev[fl.team];
      if (fl.state === 'carried' && was?.state !== 'carried') {
        carries.push({ grabT: m._s ?? 0, result: 'held' });
      } else if (was?.state === 'carried' && fl.state === 'dropped') {
        const c = carries.findLast((x) => x.result === 'held');
        if (c) { c.endT = m._s ?? 0; c.result = 'drop'; }
      } else if (was?.state === 'carried' && fl.state === 'home') {
        const c = carries.findLast((x) => x.result === 'held');
        if (c) { c.endT = m._s ?? 0; c.result = 'cap'; }
      } else if (fl.state === 'home' && was?.state === 'dropped') {
        returns++;
      }
      prev[fl.team] = { state: fl.state };
    }
  }
  const done = carries.filter((c) => c.result !== 'held');
  const holds = done.map((c) => (c.endT ?? 0) - c.grabT).sort((a, b) => a - b);
  return {
    grabs: carries.length,
    caps: done.filter((c) => c.result === 'cap').length,
    drops: done.filter((c) => c.result === 'drop').length,
    returns,
    medHold: holds.length ? holds[Math.floor(holds.length / 2)]! : 0,
    awayS: awayTicks * dt,
    hofKills,
    hofDeaths,
    kills,
    scoreA: room.scores.alpha,
    scoreB: room.scores.bravo,
  };
}
