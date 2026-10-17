/**
 * RoomConquest — the Room-hosted ConquestSim adapter. The lattice rules
 * live in shared/conquestSim.ts (the solo client runs the same sim); this
 * file only maps Room's seams onto the ConquestHost contract and answers
 * the ModeModule interface. Deleting the registry line in modeModules
 * still removes the whole mode.
 */
import { ConquestSim, type ConquestObjective } from '../../shared/conquestSim.ts';
import type { TeamId, TeamScores } from '../../shared/teams.ts';
import type { MapSpec, StructureSpec } from '../../shared/mapSpec.ts';
import { HM_WORLD_SCALE } from '../../shared/heightfield.ts';
import type { Room } from './Room.ts';
import type { ModeModule, ModeObjective } from './modeModules.ts';
import type { RoomEvent } from './roomEvents.ts';
import type { Vec3, ServerMessage } from './types.ts';

export class RoomConquest implements ModeModule {
  readonly sim: ConquestSim;
  /** Exposed for soak/tests that read the raw lattice (was RoomConquest.nodes). */
  get nodes() { return this.sim.nodes; }

  constructor(private readonly room: Room) {
    this.sim = new ConquestSim({
      groundAt: (x, z): number => room.players.groundAt?.(x, z) ?? 0,
      bodies: (): Iterable<{ id: string; team?: string; position: Vec3; isDead?: boolean }> => room.players.getAllPlayers().values(),
      teamOf: (id): TeamId | undefined => room.players.getPlayer(id ?? '')?.team as TeamId | undefined,
      emitNodes: (rows): void => { room.broadcast({ type: 'nodeUpdate', nodes: rows } as ServerMessage); },
      setScores: (a, b): void => {
        const s = room.scores;
        if (s.alpha === a && s.bravo === b) {return;}
        s.alpha = a;
        s.bravo = b;
        room.broadcast({ type: 'teamScore', scores: Object.assign({}, s as TeamScores), winAt: room.modeSpec?.winAt ?? 999 });
      },
      setSpawns: (rings, bases): void => {
        room.players.teamSpawns = rings;
        room.players.teamBases = bases;
      },
      splat: (pos): void => { room.influence.splat(pos, 'opportunity', 1); },
      endMatch: (team): void => room.endMatch(team),
    }, room.spec.tileSize ?? HM_WORLD_SCALE);
    // Nodes eat the same blast stream deployables do — no new damage
    // plumbing; hitscan can't hurt them (nodes are blast-only, matching
    // the codebase's blast-durability rule for objectives).
    this.room.events.on((e: RoomEvent): void => {
      if (e.type === 'blast') {this.sim.applyBlast(e.pos, e.damage, e.radius, e.shooterId, e.scales);}
    });
  }

  /** Node bases as structure specs — 'kit' pieces ride RoomStructures.eff()
   *  so sims collide with the bases and the wire echo builds the real
   *  meshes client-side (katastand node, gendome core). Owner flips don't
   *  retint the kit mesh — the ring/beam/links carry the live owner read. */
  structures(): StructureSpec[] {
    return this.sim.structures();
  }

  sims(): { name: string; tick(dt: number): void; worldState(): ServerMessage[] }[] {
    return [{
      name: 'nodes',
      tick: (dt: number): void => this.sim.tick(dt),
      worldState: (): ServerMessage[] => [{ type: 'nodeUpdate', nodes: this.sim.snapshot() } as ServerMessage],
    }];
  }

  /** Standing objective for one bot — the lattice's frontier pick,
   *  consulted BEFORE the CTF goal ladder in serverSenses. */
  objectiveFor(p: { id: string; team?: string; position: Vec3 }): ModeObjective | null {
    return this.sim.objectiveFor(p) as ConquestObjective | null;
  }

  /** Match boundary — endCleanup's reset funnel lands here. */
  reset(): void {
    this.sim.reset();
  }

  /** Spec rotation (map rotation / admin reload) — re-layout on the new span. */
  onSpec(spec: MapSpec): void {
    this.sim.onSpec(spec.tileSize ?? HM_WORLD_SCALE);
  }

  /** Live terrain (re)attach — re-snap positions, keep match state. */
  onTerrain(): void {
    this.sim.onTerrain();
  }

  telemetry(): string {
    return this.sim.telemetry();
  }
}
