/**
 * ModeModules — the pluggable-gamemode seam. Everything a mode needs
 * beyond the declarative ModeSpec flags (teams/flags/gems/winAt) lives
 * behind this interface: its own sim(s), wire traffic, bot objective
 * provider and reset/layout hooks. Room consults the registry at a
 * handful of seams (ctor feature wiring, registerSims, match cleanup,
 * spec rotation, terrain attach); a mode file + one registry line is the
 * whole cost of a new gamemode, and removing it touches nothing else.
 */
import type { Room } from './Room.ts';
import type { MapSpec, StructureSpec } from '../../shared/mapSpec.ts';
import type { BotVec } from '../../shared/botVec.ts';
import type { Vec3, ServerMessage } from './types.ts';
import { RoomConquest } from './modeConquest.ts';

/** Bot goal descriptor — the same shape botRouting.flagGoal returns so
 *  brains stay mode-agnostic: they walk ctx.objective and fight. */
export interface ModeObjective {
  pos: BotVec;
  flagPos?: BotVec | null;
  infiltrating?: boolean;
  running?: boolean;
  runner?: boolean;
  wave?: boolean;
  marshal?: boolean;
  posted?: number;
}

export interface ModeModule {
  /** Sims to register — tick rides the room loop; worldState replays to
   *  joiners/resync through the same sendWorldState funnel every sim uses. */
  sims?(): { name: string; tick(dt: number): void; worldState?(): ServerMessage[] }[];
  /** Standing objective for one bot — consulted BEFORE the CTF goal
   *  ladder, so a mode with a module owns its bots' priorities outright.
   *  null = no mode opinion (brains fall through to pickup/wander). */
  objectiveFor?(p: { id: string; team?: string; position: Vec3 }): ModeObjective | null;
  /** Match-boundary reset — roomMatch endCleanup calls it alongside
   *  flags.reset()/pickups.clear(). */
  reset?(): void;
  /** Mode-owned structures — concatenated into RoomStructures.eff(), so
   *  colliders, ball/projectile sims and the wire echo all see mode
   *  geometry through the same authored-structure pipeline. */
  structures?(): StructureSpec[];
  /** Spec swap (map rotation / admin reload) — re-layout on the new map. */
  onSpec?(spec: MapSpec): void;
  /** Live terrain (re)attached — re-snap positions, keep match state. */
  onTerrain?(): void;
  /** One-line economy/health readout for soak reports. */
  telemetry?(): string;
}

/** The registry — a mode is hostable once its ctor lands here. Modules
 *  are created in the Room ctor (before bot populate, so spawn pools
 *  minted by the module cover the initial seating). */
export const MODE_MODULES: Record<string, (room: Room) => ModeModule> = {
  conquest: (room): ModeModule => new RoomConquest(room),
};
