/** beamSweep — the honest ray Lightning/Repair intents resolve through.
 *  Free-function so BOTH authority shapes run the identical cast: Room's
 *  method delegates with its live sims; P2PHost calls the same code with
 *  whatever it has (players + field, no creature rosters).
 *  Contact grammar: first occluder wins — terrain, structure, creature,
 *  then the player capsule; a creature hit chains to the nearest OTHER
 *  live creature forward of the beam. */

import { segFieldHit, segPointDist, segPointT } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { LG_CHAIN_RANGE } from '../../shared/combat.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { Vec3 } from './types.ts';
import type { BeamContact } from './CombatHandler.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { clampPing, rewindPos } from './claimLedger.ts';
import { renderLagOf } from './rewind.ts';

/** The sweep only reads positions/ids off the sims — structural slices
 *  keep Room's concrete sims and a P2P host's lighter set compatible. */
export interface BeamSweepWorld {
  players: PlayerManager;
  field: Heightfield | null;
  solids: readonly StructureCollider[];
  ballSim?: { balls: Map<number, { id: number; x: number; y: number; z: number; dead: boolean }>; sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null };
  creatureSim?: { crawlers: Map<number, { id: number; x: number; y: number; z: number; dead: boolean }>; sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null };
  /** Target uplink-transit estimate (ms) — the same lead the tick
   *  broadcast applies. Absent = no lead knowledge. */
  transitOf?: (playerId: string) => number;
}

export function beamSweepRay(world: BeamSweepWorld, shooterId: string, muzzle: Vec3, dir: Vec3, range: number): BeamContact | null {
  const end = { x: muzzle.x + dir.x * range, y: muzzle.y + dir.y * range, z: muzzle.z + dir.z * range };
  const at = (t: number): Vec3 => ({ x: muzzle.x + (end.x - muzzle.x) * t, y: muzzle.y + (end.y - muzzle.y) * t, z: muzzle.z + (end.z - muzzle.z) * t });
  let bestT = 1;
  if (world.field) {
    const th = segFieldHit(muzzle, end, world.field);
    if (th) bestT = segPointT(muzzle, end, th);
  }
  if (world.solids.length) {
    const sh = segSolidHit(muzzle, end, world.solids, undefined, world.players.getPlayer(shooterId)?.team);
    if (sh) bestT = Math.min(bestT, segPointT(muzzle, end, sh));
  }
  // Ghost-truth lag-comp: the shooter's beam was aimed at the rendered
  // ghost — sim(t − ping − renderDelay + broadcast lead) — so a ray
  // tested against live positions reads visible hits as misses at
  // cruise speed. Rewind each capsule to the shooter's screen point.
  const shooter = world.players.getPlayer(shooterId);
  // Bots see server truth — no render pipeline, no ghost to chase.
  const shooterPing = shooter?.isBot ? 0 : (shooter?.ping ?? 0);
  const shooterLag = shooter?.isBot ? 0 : renderLagOf(shooter);
  let playerId: string | undefined;
  for (const [pid, t] of world.players.getAllPlayers()) {
    if (pid === shooterId || t.isDead) continue;
    const cap = classCapsule(t.armorClass);
    const lead = (world.transitOf?.(pid) ?? 0) / 2;
    const back = Math.max(0, clampPing(shooterPing) + shooterLag - lead);
    const tp = rewindPos(t, back);
    const c = { x: tp.x, y: tp.y + cap.centerOff, z: tp.z };
    if (segPointDist(muzzle, end, c) > cap.radius + 0.2 + cap.half) continue;
    const tt = segPointT(muzzle, end, c);
    if (tt <= bestT) { bestT = tt; playerId = pid; }
  }
  // Creatures broadcast raw positions (no lead), so their ghost is
  // a flat ping+renderDelay behind — no per-target lead to subtract.
  const creatureBack = clampPing(shooterPing) + shooterLag;
  const bc = world.ballSim?.sweepHit(muzzle, end, 0.2, creatureBack);
  if (bc && bc.t <= bestT) {
    return { ballId: bc.id, contact: at(bc.t), ...beamChain(world, at(bc.t), dir, bc.id, undefined) };
  }
  const cc = world.creatureSim?.sweepHit(muzzle, end, 0.2, creatureBack);
  if (cc && cc.t <= bestT) {
    return { crawlerId: cc.id, contact: at(cc.t), ...beamChain(world, at(cc.t), dir, undefined, cc.id) };
  }
  if (playerId !== undefined) return { playerId, contact: at(bestT) };
  return bestT < 1 ? { contact: at(bestT) } : null;
}

/** Chain-fork pick — the nearest OTHER live creature within range of
 *  the primary contact, forward-ish of the beam so the arc can't
 *  reach backward through the shooter. */
function beamChain(world: BeamSweepWorld, contact: Vec3, dir: Vec3, excludeBall: number | undefined, excludeCrawler: number | undefined):
    { chainBallId?: number; chainCrawlerId?: number; chainContact?: Vec3 } {
  const cands: { id: number; kind: 'ball' | 'crawl'; x: number; y: number; z: number; d2: number }[] = [];
  const consider = (kind: 'ball' | 'crawl', id: number, x: number, y: number, z: number): void => {
    const dx = x - contact.x, dy = y - contact.y, dz = z - contact.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= LG_CHAIN_RANGE * LG_CHAIN_RANGE) return;
    const d = Math.sqrt(d2) || 1;
    if ((dx * dir.x + dy * dir.y + dz * dir.z) < d * 0.35) return;
    cands.push({ id, kind, x, y, z, d2 });
  };
  for (const b of world.ballSim?.balls.values() ?? []) {
    if (b.dead || b.id === excludeBall) continue;
    consider('ball', b.id, b.x, b.y, b.z);
  }
  for (const c of world.creatureSim?.crawlers.values() ?? []) {
    if (c.dead || c.id === excludeCrawler) continue;
    consider('crawl', c.id, c.x, c.y, c.z);
  }
  let best: (typeof cands)[number] | null = null;
  for (const c of cands) { if (!best || c.d2 < best.d2) best = c; }
  if (!best) return {};
  return best.kind === 'ball'
    ? { chainBallId: best.id, chainContact: { x: best.x, y: best.y, z: best.z } }
    : { chainCrawlerId: best.id, chainContact: { x: best.x, y: best.y, z: best.z } };
}
