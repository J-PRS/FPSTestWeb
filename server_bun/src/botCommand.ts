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
  /** Assignment stamp — bounds the flood window for push tasks. */
  born: number;
}

/** How long a push task outlives its call: the call's PUSH_HOLD_MS (~14s)
 *  is half a transit leg on a 1km map, so deleting the task the moment
 *  the slot goes quiet un-calls the flood mid-run — the soak's whole
 *  "wave transits ~500m and never arrives" defect. The flood's job ends
 *  on arrival, on this window, or when the slot re-opens (a fresh call
 *  or a carried flag re-contests it). */
const FLOOD_MS = 45_000;

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
  // A called push wants a real flood — three bodies reads as a patrol,
  // not a wave; four is most of the eligible pool arriving together.
  // Long transit legs bleed members before arrival (katabatic's 500m
  // haul kills ~3 of 4 mid-field), so a far call floods deeper.
  push: 4,
};
/** Extra bodies a push earns per ~350m the wave must transit — the
 *  transit is a death lottery, so a far call floods deeper to land
 *  the same suppression on the ring. */
const PUSH_FAR_M = 350;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

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
    this.contested.clear();
    const slots: Record<CommandKind, (BotVec & { vx?: number; vz?: number }) | null | undefined> = {
      chase: s.thief, return: s.dropped, escort: s.escort, push: s.push };
    // Assignments PERSIST between passes — the nearest-eligible re-roll
    // every 2s kept swapping the job to whoever just respawned at home,
    // so the wave never finished a leg (soak: tasked members orbited
    // ~180m out forever, near2%). A task only dies with its job slot
    // or its assignee; understaffed slots top up instead of re-rolling.
    const alive = new Set(members.map((m) => m.id));
    for (const [id, t] of [...this.tasks]) {
      const slot = slots[t.kind];
      if (!alive.has(id)) { this.tasks.delete(id); continue; }
      if (!slot) {
        // Dead slot: chase/return/escort goals are moving targets — no
        // live slot means no job. Push is different: the stand doesn't
        // move, so the task keeps its goal until the member arrives or
        // the flood window lapses.
        if (t.kind === 'push' && now - t.born < FLOOD_MS) {
          const m = members.find((mm) => mm.id === id);
          const arrived = m && (m.pos.x - t.goal.x) ** 2 + (m.pos.z - t.goal.z) ** 2 < 40 * 40;
          if (!arrived) continue;
        }
        this.tasks.delete(id);
        continue;
      }
      t.goal = { x: slot.x, y: slot.y, z: slot.z };
    }
    const free = members.filter((m) => !m.carrier);
    const assign = (kind: CommandKind, at: (BotVec & { vx?: number; vz?: number }) | null | undefined) => {
      if (!at) return;
      const have = [...this.tasks.values()].filter((t) => t.kind === kind).length;
      const want = kind === 'push'
        ? WANT.push + Math.min(3, Math.floor(median(free.map((m) =>
            Math.hypot(m.pos.x - at.x, m.pos.z - at.z))) / PUSH_FAR_M))
        : WANT[kind];
      const pool = free
        .filter((m) => !this.tasks.has(m.id) && WHO[kind].has(m.role))
        .map((m) => ({ m, d: (m.pos.x - at.x) ** 2 + (m.pos.z - at.z) ** 2 }))
        .sort((a, b) => a.d - b.d);
      for (const { m } of pool.slice(0, Math.max(0, want - have))) {
        // Escort intercept: aiming at where the carrier IS trails a
        // runner you'll never meet — each escort aims at where the
        // carrier will be when the escort's own run lands (est ~12m/s).
        const eta = kind === 'escort' ? Math.min(12, Math.sqrt(
          (m.pos.x - at.x) ** 2 + (m.pos.z - at.z) ** 2) / 12) : 0;
        this.tasks.set(m.id, { kind, born: now, goal: {
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

  /** Test hook — the live assignment list (soak wave probe). */
  debugTasks(): { id: string; kind: string; goal: BotVec }[] {
    return [...this.tasks.entries()].map(([id, t]) => ({ id, kind: t.kind, goal: t.goal }));
  }

  /** True when a contested slot is staffed by someone else — senses
   *  drops that slot from the situation before roleObjective reads it,
   *  so the untasked defender holds home instead of lemming. */
  staffed(id: string, kind: CommandKind): boolean {
    if (!this.contested.has(kind)) return true; // nobody to staff it anyway
    return this.tasks.get(id)?.kind === kind ? false : true;
  }
}
