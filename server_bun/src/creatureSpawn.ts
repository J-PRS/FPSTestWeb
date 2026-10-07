/**
 * creatureSpawn — CreatureSim's spawn + target-selection family, split
 * so CreatureSim stays about tick/edge cadence. Everything here answers
 * "who can creatures see" (alive + uncloaked players + deployable
 * gnawables), "who does a new creature pull toward", and "where does it
 * appear" — including the committed target snapshot that keeps server
 * and client replays on the same aim point.
 */
import { type Heightfield, hmHeight } from '../../shared/heightfield.ts';
import {
  SPECIES_FAMILY, speciesFamily,
  commitTarget,
} from '../../shared/creatureSim.ts';
import { type SimBeing, type CreatureBrain } from './creatureBrain.ts';
import type { SimVec } from '../../shared/ballSim.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';
import { WORLD_MODEL, spawnPayload } from '../../shared/worldModel.ts';
import { simNow } from './simClock.ts';

export interface SpawnHost {
  field: Heightfield | null;
  rng: () => number;
  simTime: number;
  nextId: number;
  players: PlayerManager;
  readonly crawlers: Map<number, SimBeing>;
  broadcast: (msg: ServerMessage) => void;
  extraTargets: (() => { id: string; pos: SimVec }[]) | null;
  targetPos: ((id: string) => SimVec | null) | null;
  brain: CreatureBrain;
  targetSnap(c: SimBeing): Vec3 | null;
  snapTarget(c: SimBeing): void;
}

export function alivePlayers(h: SpawnHost): { id: string; pos: SimVec }[] {
  const out: { id: string; pos: SimVec }[] = [];
  for (const [id, p] of h.players.getAllPlayers()) {
    // Firing decloaks — a cloaked shooter is fodder for the reveal
    // window, same rule the ball sim and bot senses apply.
    if (!p.isDead && (!(p.status & STATUS.CLOAK) || shootRevealed(p.lastFireSim, simNow()))) out.push({ id, pos: p.position });
  }
  if (h.extraTargets) out.push(...h.extraTargets());
  return out;
}

/** Nearest alive, uncloaked target — the fodder rule. */
export function nearestPlayer(c: SimBeing, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null {
  let best: { id: string; pos: SimVec } | null = null;
  let bestD = Infinity;
  for (const p of alive) {
    const d = (p.pos.x - c.x) ** 2 + (p.pos.z - c.z) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

export function spawnCrawler(h: SpawnHost, near: SimVec, species: string): SimBeing {
  const field = h.field!;
  const ang = h.rng() * Math.PI * 2;
  const dist = 40 + h.rng() * 50;
  const x = near.x + Math.cos(ang) * dist;
  const z = near.z + Math.sin(ang) * dist;
  const seed = (h.rng() * 0xffffffff) >>> 0 || 1;
  const gy = hmHeight(field, x, z);
  const id = h.nextId++;
  const uber = h.rng() < 0.05;
  const fam = SPECIES_FAMILY[speciesFamily(species)];
  const c: SimBeing = fam.make(id, { x, y: gy, z }, uber, seed, species);
  c.y = gy + fam.lift(c);
  // Negative offset pushes this crawler's first retarget into its own
  // bucket instead of the spawn tick — the spread survives every reset.
  h.brain.seedBuckets(c.id);
  c.targetId = nearestPlayer(c, alivePlayers(h))?.id ?? null;
  h.snapTarget(c);
  h.crawlers.set(c.id, c);
  h.broadcast(spawnPayload(WORLD_MODEL.creature!, c.id, 'id', {
    position: { x: c.x, y: c.y, z: c.z },
    seed, uber: c.uber, species: c.species,
    targetId: c.targetId, tp: h.targetSnap(c),
    t: h.simTime,
  }) as ServerMessage);
  return c;
}

/** Freeze the pounce/chase aim into the sim — same rationale as
 *  BallSim.snapTarget: both sides steer at THIS snapshot, not the
 *  moving player. */
export function snapTarget(h: SpawnHost, c: SimBeing): void {
  const p = c.targetId ? h.players.getPlayer(c.targetId) : null;
  if (p && !p.isDead && (!(p.status & STATUS.CLOAK) || shootRevealed(p.lastFireSim, simNow()))) {
    commitTarget(c, c.targetId, p.position);
  } else if (c.targetId && h.targetPos) {
    const tp = h.targetPos(c.targetId);
    if (tp) { commitTarget(c, c.targetId, tp); return; }
    commitTarget(c, null, null);
  } else {
    commitTarget(c, null, null);
  }
}

export function targetSnap(c: SimBeing): Vec3 | null {
  return c.tgtValid ? { x: c.tx, y: c.ty, z: c.tz } : null;
}
