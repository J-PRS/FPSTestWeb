/**
 * botCommand — the per-team commander (Killzone-shaped, tiny): the flag
 * situation is the same FlagSituation every role reads, but contested
 * jobs — chase the thief, return a dropped flag, escort the carrier,
 * flood the push — get NAMED responders instead of "everyone whose role
 * table mentions it". Without deconfliction one thief empties the whole
 * home defense, which reads as bots lemming a single stimulus.
 *
 * The commander answers two questions for senses.flagGoal:
 *   taskFor(id)      → this bot drew the job, here's the goal.
 *   suppressed(id)   → somebody else has it — drop the contested slots
 *                      (thief/dropped/escort/push) before roleObjective
 *                      runs, so the untasked defender holds home.
 *
 * Recomputed on a slow cadence per team; assignments persist between
 * passes (a re-roll every think would dither) and die with the job.
 */
import type { FlagSituation } from '../../shared/flagGoals.ts';
import type { BotVec } from '../../shared/botBrain.ts';

export type CommandKind = 'chase' | 'return' | 'escort' | 'push';
export interface CommandTask {
  kind: CommandKind;
  goal: BotVec;
}

export interface CommandMember {
  id: string;
  role: string;
  pos: { x: number; z: number };
  /** Carriers are never reassigned — the run is the job. */
  carrier?: boolean;
}

/** How many named responders each job earns — the Killzone "optimal
 *  squad size" per order. Chasing one thief wants a hunter pair, not a
 *  platoon; a called push wants a real flood. */
const WANT: Record<CommandKind, number> = {
  chase: 2,
  return: 1,
  escort: 2,
  push: 3,
};

/** Which roles volunteer for which job — defenders chase and return,
 *  attackers escort and flood. */
const WHO: Record<CommandKind, Set<string>> = {
  // No 'hof' anywhere — heavy-on-flag never chases and never returns:
  // sitting AT home made him the nearest volunteer every pass, which
  // pulled him off the stand as a named responder. His own goal table
  // still grabs a dropped flag within arm's reach.
  chase: new Set(['ldefense', 'defense', 'offense']),
  return: new Set(['ldefense', 'defense', 'offense', 'technician']),
  escort: new Set(['offense', 'capper', 'medic']),
  push: new Set(['offense', 'infiltrator', 'bombardier']),
};

export class TeamCommand {
  private tasks = new Map<string, CommandTask>();
  private contested = new Set<string>();
  private reassignT = 0;

  /** Slow pass (~2s): the situation is only contested while its slots
   *  are live; each live slot names its K nearest eligible volunteers,
   *  nearest first, no bot holding two jobs. */
  update(now: number, s: FlagSituation, members: CommandMember[]): void {
    if (now - this.reassignT < 2000) return;
    this.reassignT = now;
    this.tasks.clear();
    this.contested.clear();
    const free = members.filter((m) => !m.carrier);
    const assign = (kind: CommandKind, at: (BotVec & { vx?: number; vz?: number }) | null | undefined) => {
      if (!at) return;
      const pool = free
        .filter((m) => !this.tasks.has(m.id) && WHO[kind].has(m.role))
        .map((m) => ({ m, d: (m.pos.x - at.x) ** 2 + (m.pos.z - at.z) ** 2 }))
        .sort((a, b) => a.d - b.d);
      for (const { m } of pool.slice(0, WANT[kind])) {
        // Escort intercept: aiming at where the carrier IS trails a
        // runner you'll never meet — each escort aims at where the
        // carrier will be when the escort's own run lands (est ~12m/s).
        const eta = kind === 'escort' ? Math.min(12, Math.sqrt(
          (m.pos.x - at.x) ** 2 + (m.pos.z - at.z) ** 2) / 12) : 0;
        this.tasks.set(m.id, { kind, goal: {
          x: at.x + (at.vx ?? 0) * eta,
          y: at.y,
          z: at.z + (at.vz ?? 0) * eta,
        } });
      }
      this.contested.add(kind);
    };
    // Order matters — a dropped flag is a heart-beat job, escort and
    // push split the offense after it.
    assign('chase', s.thief);
    assign('return', s.dropped);
    assign('escort', s.escort);
    assign('push', s.push);
  }

  /** The named responder's job, if any. */
  taskFor(id: string): CommandTask | undefined {
    return this.tasks.get(id);
  }

  /** True when a contested slot is staffed by someone else — senses
   *  drops that slot from the situation before roleObjective reads it,
   *  so the untasked defender holds home instead of lemming. */
  staffed(id: string, kind: CommandKind): boolean {
    if (!this.contested.has(kind)) return true; // nobody to staff it anyway
    return this.tasks.get(id)?.kind === kind ? false : true;
  }
}
