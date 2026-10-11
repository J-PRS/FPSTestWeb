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
import { inv } from '../../shared/invariants.ts';

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
   *  the stand. undefined = unaffiliated → the flat-pool fallback
   *  (bias 2 toward own base) applies; 0 would suppress it. */
  homeBias?(playerId: string): number | undefined;
  /** A tasked member's job position + pull — overrides home scoring: the
   *  flood that respawns at base re-runs the transit that killed it. */
  objective?(playerId: string): { pos: Vec3; w: number } | null;
  /** Ground height at (x,z) — live heightfield. */
  groundAt(): ((x: number, z: number) => number) | undefined;
  /** Jitter source — Room wires its rng so tests can seed it. */
  rng(): number;
}

export class SpawnPicker {
  /** A living enemy inside this radius marks a spawn camped — the
   *  objective pull can't claim it (attack goals sit in enemy
   *  territory; uncapped it materializes the respawner into the
   *  defended base). Sized under typical stand-defense spacing. */
  private static readonly CAMPED_R = 45;

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
    // No living enemies at all: every point is equally safe, and scoring
    // degenerates to 0-everything → always points[0] — a respawn spot a
    // camper can learn. Random instead; team modes with bias>0 still
    // prefer their base through the fallback below (same effect, since
    // baseDist breaks the tie there too — but a flat pick is fairer
    // than the first authored sphere for everyone else).
    const obj = this.host.objective?.(playerId) ?? null;
    const bias = obj ? obj.w : (this.host.homeBias?.(playerId) ?? (teamPool ? 0 : 2));
    if (!obj && bias === 0) {
      const anyFoe = [...this.host.players().entries()].some(
        ([id, p]) => id !== playerId && !p.isDead && (!team || p.team !== team));
      if (!anyFoe) return { ...points[Math.floor(this.host.rng() * points.length)]! };
    }
    // Home pull target for points that can't ride the objective pull.
    const ownBase = bias > 0 && (team === 'alpha' || team === 'bravo')
      ? this.host.teamBases()?.[team] : undefined;
    let best: SpawnPoint = { ...points[0]! };
    let bestScore = -Infinity;
    for (const spawn of points) {
      const minFoeDist = this.foeClearance(spawn, playerId, team);
      // A camped point can't ride the objective pull — attack goals sit
      // in enemy territory, and on maps with only base-adjacent spheres
      // (bastion's flat pool) the w-term otherwise materializes the
      // respawner inside the enemy's defended base. Unsafe points fall
      // back to the home pull, which already penalizes the transit.
      const objOk = !!obj && minFoeDist > SpawnPicker.CAMPED_R;
      const pullPos = objOk ? obj!.pos : obj ? ownBase : (bias > 0 ? ownBase : undefined);
      const pullW = objOk ? obj!.w : bias;
      const score = (pullPos
        ? minFoeDist - pullW * Math.hypot(spawn.x - pullPos.x, spawn.z - pullPos.z)
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
    const groundAt = this.host.groundAt();
    if (anchor.r && anchor.r > 0) {
      const a = this.host.rng() * Math.PI * 2;
      const d = anchor.r * Math.sqrt(this.host.rng());
      out.x += Math.cos(a) * d;
      out.z += Math.sin(a) * d;
      const g = groundAt?.(out.x, out.z);
      if (g !== undefined && Number.isFinite(g) && out.y < g) out.y = g;
    }
    // Postcondition: a spawn born under its surface is the buried-bot
    // seed — name it at the pick, not after the corpse renders sunk. A
    // field that can't produce a finite floor (degenerate test hosts)
    // isn't evidence of burial.
    const g2 = groundAt?.(out.x, out.z);
    inv('spawn-above-ground', g2 === undefined || !Number.isFinite(g2) || out.y >= g2 - 0.5,
      { x: out.x, y: out.y, z: out.z, ground: g2 });
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
