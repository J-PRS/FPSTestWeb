/**
 * spawnPicker — spawn-point selection for PlayerManager: authored anchors
 * lifted onto live terrain, then scored by enemy clearance (and own-base
 * proximity in team modes). Kept apart so spawn heuristics evolve with
 * objective layout without touching the roster/damage surface.
 */
import type { PlayerState, Vec3 } from './types.ts';
import { CONFIG } from './config.ts';

import type { TeamId } from '../../shared/teams.ts';
export interface SpawnPickerHost {
  players(): Map<string, PlayerState>;
  /** Spawn anchors — map specs override, default is the config ring. */
  spawnPoints(): Vec3[] | null;
  /** Team home bases — own-flag spawns when set. */
  teamBases(): { alpha: Vec3; bravo: Vec3 } | null;
  /** Ground height at (x,z) — live heightfield. */
  groundAt(): ((x: number, z: number) => number) | undefined;
}

export class SpawnPicker {
  constructor(private host: SpawnPickerHost) {}

  pick(playerId: string, team?: TeamId): Vec3 {
    const points: Vec3[] = (this.host.spawnPoints() ?? CONFIG.spawnPoints).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    // Authored anchors predate the current terrain — anything buried
    // under the field lifts to the surface rather than spawning into it.
    const groundAt = this.host.groundAt();
    if (groundAt) {
      for (const p of points) {
        const g = groundAt(p.x, p.z);
        if (p.y < g) p.y = g;
      }
    }
    if (this.host.players().size === 0) {
      return { ...points[0]! };
    }

    // Team modes prefer own-base spawns — materializing among enemies is
    // instant camp food. Score blends base proximity with enemy clearance.
    const base = team === 'alpha' || team === 'bravo' ? this.host.teamBases()?.[team] : undefined;
    let best: Vec3 = { ...points[0]! };
    let bestScore = -Infinity;

    for (const spawn of points) {
      const minFoeDist = this.foeClearance(spawn, playerId, team);
      const score = base
        ? minFoeDist - 2 * Math.hypot(spawn.x - base.x, spawn.z - base.z)
        : minFoeDist;
      if (score > bestScore) {
        bestScore = score;
        best = { ...spawn };
      }
    }

    return best;
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
