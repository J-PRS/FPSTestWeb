/**
 * SoloConquest — the offline conquest module. Same ConquestSim the
 * dedicated Room runs (shared/conquestSim.ts); the host seams answer
 * with local state: terrain heightfield, the TeamBots roster + the
 * local player, the same onNodeUpdate paint path the real wire uses,
 * and botMatch's win/spawn plumbing. A conquest solo match is now the
 * mode, not just its scoreboard label.
 *
 * Scope vs the Room version: no influence telemetry. Node bases are
 * solid here too — the kit hulls feed the extraStructures seam so solo
 * collision matches what the wire echo builds online.
 */
import * as THREE from 'three';
import { ConquestSim, type ConquestBody } from '../../../shared/conquestSim.js';
import type { TeamId } from '../../../shared/teams.ts';
import { KIT_BUILDERS } from '../world/mapStructures.js';
import { setExtraStructures } from './structureSpecs.js';
import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { GameBot } from './bots/botBrain.js';
import type { WorldState } from './worldState.js';

/** The flat seam list the module reads — same lazy-getter pattern the
 *  rest of the game deps use. */
export interface SoloConquestDeps {
  world: WorldState;
  scene: THREE.Scene;
  lazyPlayer: () => Player;
  lazyTerrain: () => Terrain;
  lazyNetworkManager: () => NetworkManager;
  lazyHud: () => { setTeamScore?(a: number, b: number): void };
  /** Spawn rings the sim mints land here — spawnSpot consults them
   *  before the map spec (TeamBots.nodeSpawns). */
  setNodeSpawns: (rings: Record<TeamId, { x: number; y: number; z: number; r: number }[]>) => void;
  teamOfBot: (id: string) => string | undefined;
  bots: () => GameBot[];
  /** Core death → win — lands in TeamBots.conquestWin, picked up by the
   *  same over-check the other modes use. */
  setWinner: (team: TeamId) => void;
  /** teamScore writer for the offline board. */
  setTeamScores: (a: number, b: number) => void;
}

export class SoloConquest {
  readonly sim: ConquestSim;
  private readonly group = new THREE.Group();

  constructor(deps: SoloConquestDeps, span: number) {
    const bodyScratch = { local: { id: 'local', team: undefined as string | undefined, position: deps.lazyPlayer().pos, isDead: false } };
    this.sim = new ConquestSim({
      groundAt: (x, z): number => {
        const g = deps.lazyTerrain().getHeight(x, z);
        return Number.isFinite(g) ? g : 0;
      },
      bodies: function* (): Iterable<ConquestBody> {
        const p = deps.lazyPlayer();
        bodyScratch.local.team = deps.world.localTeam;
        bodyScratch.local.isDead = p.isDead;
        yield bodyScratch.local;
        for (const b of deps.bots()) {
          yield { id: b.playerId, team: b.team, position: b.position, isDead: b.isDead };
        }
      },
      // 'local'/undefined shooters are the player — everything else is a
      // bot id resolved through the roster's team map.
      teamOf: (id): TeamId | undefined => {
        if (id === undefined || id === 'local') {return deps.world.localTeam as TeamId | undefined;}
        return deps.teamOfBot(id) as TeamId | undefined;
      },
      // The wire handler is registered unconditionally at boot — feeding
      // it rows paints rings/beams/links/nodeMarkers/commandmap cells
      // exactly like the server's broadcast does.
      emitNodes: (rows): void => { deps.lazyNetworkManager().onNodeUpdate?.(rows as never); },
      setScores: (a, b): void => { deps.setTeamScores(a, b); deps.lazyHud().setTeamScore?.(a, b); },
      setSpawns: (rings): void => deps.setNodeSpawns(rings),
      endMatch: (team): void => deps.setWinner(team),
    }, span);

    // Stand/dome meshes — the wire echo builds these online; solo builds
    // the same kit pieces locally (no colliders — see header).
    for (const spec of this.sim.structures()) {
      const mk = KIT_BUILDERS[spec.piece ?? ''];
      if (!mk) {continue;}
      const g = mk(0);
      g.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
      this.group.add(g);
    }
    deps.scene.add(this.group);
    // And the hulls — hosted clients collide with the echo's kit specs;
    // solo feeds the same KIT_HULLS pieces through the extra seam.
    setExtraStructures(this.sim.structures());
    // First paint — the dirty flush inside tick handles churn, but the
    // lattice should exist before the first tick too.
    this.sim.flush();
  }

  tick(dt: number): void { this.sim.tick(dt); }
  /** Match reset — botMatch's resetMatch funnel re-mints the lattice. */
  reset(): void { this.sim.reset(); setExtraStructures(this.sim.structures()); }
  applyBlast(pos: THREE.Vector3, damage: number, radius: number, shooterId: string | undefined, scales?: readonly number[]): void {
    this.sim.applyBlast(pos, damage, radius, shooterId, scales);
  }

  /** TeamBots objective seam — same shape the ctf/flagrun bridges hand
   *  the brain ctx (pos + infiltrating). Per-bot scratch vector: the
   *  ctx cache holds pos between thinks, so one shared scratch would
   *  have every bot staring at the last pick. */
  private readonly objPos = new Map<string, THREE.Vector3>();
  objectiveInfoFor(bot: GameBot): { pos: THREE.Vector3; infiltrating: boolean } | null {
    const o = this.sim.objectiveFor({ id: bot.playerId, team: bot.team, position: bot.position });
    if (!o) {return null;}
    let v = this.objPos.get(bot.playerId);
    if (!v) {v = new THREE.Vector3(); this.objPos.set(bot.playerId, v);}
    v.set(o.pos.x, o.pos.y, o.pos.z);
    return { pos: v, infiltrating: o.infiltrating };
  }

  /** Nearest owned node to revive on — the local player's mirror of the
   *  bots' node-linked spawns (cores are always owned, so this never
   *  starves while a core stands). */
  spawnSpot(team: TeamId, out: THREE.Vector3): THREE.Vector3 {
    const owned = this.sim.nodes.filter((n): boolean => n.owner === team);
    const n = owned[Math.floor(Math.random() * owned.length)];
    if (!n) {return out;}
    return out.set(n.pos.x + (Math.random() - 0.5) * 8, n.pos.y + 2, n.pos.z + (Math.random() - 0.5) * 8);
  }

  dispose(scene: THREE.Scene): void { scene.remove(this.group); setExtraStructures([]); }
}
