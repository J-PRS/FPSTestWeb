/**
 * spawnPicker — spawn-point selection for PlayerManager: authored anchors
 * lifted onto live terrain, then scored by enemy clearance (and own-base
 * proximity in team modes). Kept apart so spawn heuristics evolve with
 * objective layout without touching the roster/damage surface.
 */
import type { PlayerState, Vec3 } from './types.ts';
import type { SpawnPoint } from '../../shared/mapSpec.ts';
import { CONFIG } from './config.ts';
import type { TeamId } from '../../shared/teams.ts';

export interface SpawnPickerHost {
  players(): Map<string, PlayerState>;
  /** Spawn anchors — map specs override, default is the config ring. */
  spawnPoints(): SpawnPoint[] | null;
  /** Team-owned spawn volumes — when a team's list exists its members
   *  spawn only from their own spheres (T2 TeamN SimGroups). */
  teamSpawns(): { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] } | null;
  /** Team home bases — own-flag spawns when set. */
  teamBases(): { alpha: Vec3; bravo: Vec3 } | null;
  /** Per-player pull toward the home sphere — a posted defender
   *  respawning 400m forward spends a minute hiking instead of holding
   *  the stand; runners keep 0 so front-line spheres stay theirs. */
  homeBias?(playerId: string): number;
  /** Ground height at (x,z) — live heightfield. */
  groundAt(): ((x: number, z: number) => number) | undefined;
  /** Jitter source — Room wires its rng so tests can seed it. */
  rng(): number;
}

export class SpawnPicker {
  constructor(private host: SpawnPickerHost) {}

  pick(playerId: string, team?: TeamId): Vec3 {
    const { points, teamPool } = this.pool(team);
    if (this.host.players().size === 0) {
      return this.scatter(points[0]!);
    }
    return this.scatter(this.bestSpawn(points, playerId, team, teamPool));
  }

  /** Team-authored spheres win over the flat pool — spawning a bravo
   *  player inside alpha's sphere group is instant camp food. Anchors
   *  are copied then lifted: authored points predate the live terrain,
   *  so anything buried under the field rises to the surface. */
  private pool(team?: TeamId): { points: SpawnPoint[]; teamPool: SpawnPoint[] | undefined } {
    const teamPool = (team === 'alpha' || team === 'bravo')
      ? this.host.teamSpawns()?.[team] : undefined;
    const raw = teamPool?.length ? teamPool
      : (this.host.spawnPoints() ?? CONFIG.spawnPoints);
    const points: SpawnPoint[] = [];
    for (const p of raw) points.push({ ...p });
    const groundAt = this.host.groundAt();
    if (groundAt) {
      for (const p of points) {
        const g = groundAt(p.x, p.z);
        if (p.y < g) p.y = g;
      }
    }
    return { points, teamPool };
  }

  /** Team modes prefer own-base spawns — materializing among enemies is
   *  instant camp food. Score blends base proximity with enemy clearance.
   *  Team pools get base proximity only through the player's homeBias —
   *  authored forward spheres exist for runners, not for the HoF who
   *  would otherwise hike 400m back to the stand he never left. */
  private bestSpawn(points: SpawnPoint[], playerId: string, team: TeamId | undefined, teamPool: SpawnPoint[] | undefined): SpawnPoint {
    const bias = this.host.homeBias?.(playerId) ?? (teamPool ? 0 : 2);
    const base = bias > 0 && (team === 'alpha' || team === 'bravo')
      ? this.host.teamBases()?.[team] : undefined;
    let best: SpawnPoint = { ...points[0]! };
    let bestScore = -Infinity;
    for (const spawn of points) {
      const minFoeDist = this.foeClearance(spawn, playerId, team);
      const score = (base
        ? minFoeDist - bias * Math.hypot(spawn.x - base.x, spawn.z - base.z)
        : minFoeDist) * (spawn.w ?? 1) / 100;
      if (score > bestScore) {
        bestScore = score;
        best = { ...spawn };
      }
    }
    return best;
  }

  /** Sphere volumes spawn somewhere INSIDE — T2 SpawnSpheres are 30-100m
   *  volumes; using the center spawned every player at one exact spot. */
  private scatter(anchor: SpawnPoint): Vec3 {
    const out: Vec3 = { x: anchor.x, y: anchor.y, z: anchor.z };
    if (anchor.r && anchor.r > 0) {
      const a = this.host.rng() * Math.PI * 2;
      const d = anchor.r * Math.sqrt(this.host.rng());
      out.x += Math.cos(a) * d;
      out.z += Math.sin(a) * d;
      const g = this.host.groundAt()?.(out.x, out.z);
      if (g !== undefined && out.y < g) out.y = g;
    }
    return out;
  }

  /** Distance to the nearest living non-teammate from a spawn point —
   *  teammates near a spawn are safety, not a threat. Empty field scores
   *  0 (a flat map, not a jackpot). */
  private foeClearance(spawn: Vec3, playerId: string, team?: TeamId): number {
    let min = Infinity;
    for (const [id, p] of this.host.players()) {
      if (id === playerId || p.isDead) continue;
      if (team && p.team === team) continue;
      const dist = Math.hypot(spawn.x - p.position.x, spawn.z - p.position.z);
      if (dist < min) min = dist;
    }
    return min === Infinity ? 0 : min;
  }
}
