/** beamSweep — the honest ray Lightning/Repair intents resolve through.
 *  Free-function so BOTH authority shapes run the identical cast: Room's
 *  method delegates with its live sims; P2PHost calls the same code with
 *  whatever it has (players + field, no creature rosters).
 *  Contact grammar: first occluder wins — terrain, structure, creature,
 *  then the player capsule; a creature hit chains to the nearest OTHER
 *  live creature forward of the beam. */

import { segFieldHit, segPointT, segCapsuleDist } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { LG_CHAIN_RANGE, LG_BOUNCE_RANGE, lgBounceDmgScale } from '../../shared/combat.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { dhypot3 } from '../../shared/dmath.ts';
import type { Vec3 } from './types.ts';
import type { BeamContact } from './CombatHandler.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { rewindPos, shooterTransitMs } from './claimLedger.ts';
import { renderLagOf, renderLagOfTarget, renderLagBoundOf } from './rewind.ts';
import { CONFIG } from './config.ts';

/** The sweep only reads positions/ids off the sims — structural slices
 *  keep Room's concrete sims and a P2P host's lighter set compatible. */
export interface BeamSweepWorld {
  players: PlayerManager;
  field: Heightfield | null;
  solids: readonly StructureCollider[];
  /** Deployable hulls — same dynCols the projectile contact sweep uses;
   *  a turret body-blocks the beam like a wall. */
  dynSolids?: readonly StructureCollider[];
  ballSim?: { balls: Map<number, { id: number; x: number; y: number; z: number; dead: boolean }>; sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null };
  creatureSim?: { crawlers: Map<number, { id: number; x: number; y: number; z: number; dead: boolean }>; sweepHit(a: Vec3, b: Vec3, pad: number, backMs?: number): { id: number; t: number; d: number } | null };
  /** Target uplink-transit estimate (ms) — the same lead the tick
   *  broadcast applies. Absent = no lead knowledge. */
  transitOf?: (playerId: string) => number;
  /** Link jitter EMA — bounds the shooter's claimed render lag. */
  transitVarOf?: (playerId: string) => number;
}

/** Chain-fork pick — the nearest OTHER live creature within range of
 *  the primary contact, forward-ish of the beam so the arc can't
 *  reach backward through the shooter. */
type ChainCand = { id: number; kind: 'ball' | 'crawl'; x: number; y: number; z: number; d2: number };

/** Forward-ish live creatures within chain range of the contact -
 *  balls and crawlers share one candidate pool, nearest wins. */
function chainCandidates(world: BeamSweepWorld, contact: Vec3, dir: Vec3, excludeBall: number | undefined, excludeCrawler: number | undefined): ChainCand[] {
  const cands: ChainCand[] = [];
  const consider = (kind: 'ball' | 'crawl', id: number, x: number, y: number, z: number): void => {
    const dx = x - contact.x, dy = y - contact.y, dz = z - contact.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= LG_CHAIN_RANGE * LG_CHAIN_RANGE) {return;}
    const d = Math.sqrt(d2) || 1;
    if ((dx * dir.x + dy * dir.y + dz * dir.z) < d * 0.35) {return;}
    cands.push({ id, kind, x, y, z, d2 });
  };
  for (const b of world.ballSim?.balls.values() ?? []) {
    if (b.dead || b.id === excludeBall) {continue;}
    consider('ball', b.id, b.x, b.y, b.z);
  }
  for (const c of world.creatureSim?.crawlers.values() ?? []) {
    if (c.dead || c.id === excludeCrawler) {continue;}
    consider('crawl', c.id, c.x, c.y, c.z);
  }
  return cands;
}

function beamChain(world: BeamSweepWorld, contact: Vec3, dir: Vec3, excludeBall: number | undefined, excludeCrawler: number | undefined):
    { chainBallId?: number; chainCrawlerId?: number; chainContact?: Vec3 } {
  const cands = chainCandidates(world, contact, dir, excludeBall, excludeCrawler);
  let best: ChainCand | null = null;
  for (const c of cands) { if (!best || c.d2 < best.d2) {best = c;} }
  if (!best) {return {};}
  return best.kind === 'ball'
    ? { chainBallId: best.id, chainContact: { x: best.x, y: best.y, z: best.z } }
    : { chainCrawlerId: best.id, chainContact: { x: best.x, y: best.y, z: best.z } };
}



export function beamSweepRay(world: BeamSweepWorld, shooterId: string, muzzle: Vec3, dir: Vec3, range: number, includeTeammates = false): BeamContact | null {
  const end = { x: muzzle.x + dir.x * range, y: muzzle.y + dir.y * range, z: muzzle.z + dir.z * range };
  const at = (t: number): Vec3 => ({ x: muzzle.x + (end.x - muzzle.x) * t, y: muzzle.y + (end.y - muzzle.y) * t, z: muzzle.z + (end.z - muzzle.z) * t });
  let bestT = 1;
  // Terrain kept apart — a FIELD stop can bounce the bolt once; a wall
  // or hull never can.
  let fieldT = 1;
  if (world.field) {
    const th = segFieldHit(muzzle, end, world.field);
    if (th) {fieldT = segPointT(muzzle, end, th); bestT = fieldT;}
  }
  if (world.solids.length > 0) {
    const sh = segSolidHit(muzzle, end, world.solids, undefined, world.players.getPlayer(shooterId)?.team);
    if (sh) {bestT = Math.min(bestT, segPointT(muzzle, end, sh));}
  }
  if (world.dynSolids?.length) {
    const dh = segSolidHit(muzzle, end, world.dynSolids, undefined, world.players.getPlayer(shooterId)?.team);
    if (dh) {bestT = Math.min(bestT, segPointT(muzzle, end, dh));}
  }
  // Ghost-truth lag-comp: the shooter's beam was aimed at the rendered
  // ghost — sim(t − shooterTransit − renderDelay + vel·lead) — and the
  // rewind history itself rides the target's uplink, so the honest back
  // is shooterTransit + renderDelay − targetTransit. One-way hops only:
  // a full-RTT term rewinds ~RTT/2 behind the ghost and registers hits
  // on a model the shooter already watched leave the spot.
  const shooter = world.players.getPlayer(shooterId);
  // Bots see server truth — no render pipeline, no ghost to chase.
  const shooterPing = shooter?.isBot ? 0 : (shooter?.ping ?? 0);
  // Server-observed cap on the shooter's claimed staleness — the claim
  // can hint high on a clean link, it can't earn the rewind.
  const shooterBound = renderLagBoundOf(world.transitOf, world.transitVarOf, shooterId);
  const shooterLag = shooter?.isBot ? 0 : renderLagOf(shooter, shooterBound);
  const shooterTransit = shooter?.isBot ? 0 : shooterTransitMs(world.transitOf, shooterId, shooterPing);
  const creatureBack = shooterTransit + shooterLag;

  // First entity along segment a→b, capped at limitT — shared by the
  // straight leg and the terrain-bounce leg.
  const sweepEnts = (a: Vec3, b: Vec3, limitT: number, beamDir: Vec3): BeamContact | null => {
    let tMin = limitT;
    let playerId: string | undefined;
    for (const [pid, t] of world.players.getAllPlayers()) {
      if (pid === shooterId || t.isDead) {continue;}
      // Teammates aren't cover - friendly damage is refused anyway, so a
      // body-block just eats the ray (and its chain) for nothing. Heal
      // intents pass includeTeammates: the teammate IS the target there.
      if (!includeTeammates && !CONFIG.friendlyFire && shooter?.team !== undefined && t.team === shooter.team) {continue;}
      const cap = classCapsule(t.armorClass);
      const targetTransit = world.transitOf?.(pid) ?? 0;
      // Full rewind to the shooter's reported view epoch (viewLag is
      // extrapolation-aware client-side) — the literal rendered ghost.
      const back = Math.max(0, shooterTransit + renderLagOfTarget(shooter, pid, shooterBound) - targetTransit);
      const tp = rewindPos(t, back, world.field);
      const c = { x: tp.x, y: tp.y + cap.centerOff, z: tp.z };
      // Capsule test, not midpoint sphere - a beam over the helmet or
      // under the feet is a visual miss, so it must not register.
      if (segCapsuleDist(a, b, c.x, c.y - cap.half, c.y + cap.half, c.z) > cap.radius + 0.2) {continue;}
      const tt = segPointT(a, b, c);
      if (tt <= tMin) { tMin = tt; playerId = pid; }
    }
    // Creature sims run server-side — no uplink staleness in their
    // history and no broadcast lead, so the ghost sits exactly
    // shooterTransit + renderDelay back.
    const bc = world.ballSim?.sweepHit(a, b, 0.2, creatureBack);
    if (bc && bc.t <= tMin) {
      const p = { x: a.x + (b.x - a.x) * bc.t, y: a.y + (b.y - a.y) * bc.t, z: a.z + (b.z - a.z) * bc.t };
      return Object.assign({}, {ballId: bc.id, contact: p}, beamChain(world, p, beamDir, bc.id, undefined));
    }
    const cc = world.creatureSim?.sweepHit(a, b, 0.2, creatureBack);
    if (cc && cc.t <= tMin) {
      const p = { x: a.x + (b.x - a.x) * cc.t, y: a.y + (b.y - a.y) * cc.t, z: a.z + (b.z - a.z) * cc.t };
      return Object.assign({}, {crawlerId: cc.id, contact: p}, beamChain(world, p, beamDir, undefined, cc.id));
    }
    if (playerId !== undefined) {
      return { playerId, contact: { x: a.x + (b.x - a.x) * tMin, y: a.y + (b.y - a.y) * tMin, z: a.z + (b.z - a.z) * tMin } };
    }
    return null;
  };

  const first = sweepEnts(muzzle, end, bestT, dir);
  if (first) {return first;}

  // Terrain bounce: the bolt grounds, then arcs to the nearest enemy
  // within LG_BOUNCE_RANGE of the contact — any angle, half damage.
  // Only when the heightfield is the first stopper — walls and hulls
  // eat it as before.
  if (fieldT < 1 && bestT === fieldT) {
    const bp = at(fieldT);
    let bestD2 = LG_BOUNCE_RANGE * LG_BOUNCE_RANGE;
    let pick: BeamContact | null = null;
    for (const [pid, t] of world.players.getAllPlayers()) {
      if (pid === shooterId || t.isDead) {continue;}
      if (!CONFIG.friendlyFire && shooter?.team !== undefined && t.team === shooter.team) {continue;}
      const cap = classCapsule(t.armorClass);
      const targetTransit = world.transitOf?.(pid) ?? 0;
      const back = Math.max(0, shooterTransit + renderLagOfTarget(shooter, pid, shooterBound) - targetTransit);
      const tp = rewindPos(t, back, world.field);
      const c = { x: tp.x, y: tp.y + cap.centerOff, z: tp.z };
      // Distance to the capsule AXIS — a standing enemy counts even
      // when the contact is at their feet.
      const dy = Math.max(-cap.half, Math.min(cap.half, bp.y - c.y));
      const ay = c.y + dy;
      const dx = bp.x - c.x, dz = bp.z - c.z, dyy = bp.y - ay;
      const d2 = dx * dx + dyy * dyy + dz * dz - cap.radius * cap.radius;
      if (d2 <= bestD2) { bestD2 = d2; pick = { playerId: pid, contact: c }; }
    }
    const consider = (kind: 'ball' | 'crawl', id: number, x: number, y: number, z: number): void => {
      const dx = bp.x - x, dy2 = bp.y - y, dz = bp.z - z;
      const d2 = dx * dx + dy2 * dy2 + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        pick = kind === 'ball' ? { ballId: id, contact: { x, y, z } } : { crawlerId: id, contact: { x, y, z } };
      }
    };
    for (const b of world.ballSim?.balls.values() ?? []) {if (!b.dead) {consider('ball', b.id, b.x, b.y, b.z);}}
    for (const c of world.creatureSim?.crawlers.values() ?? []) {if (!c.dead) {consider('crawl', c.id, c.x, c.y, c.z);}}
    if (pick) {
      pick.dmgScale = lgBounceDmgScale(Math.sqrt(Math.max(0, bestD2)));
      const cd = { x: pick.contact.x - bp.x, y: pick.contact.y - bp.y, z: pick.contact.z - bp.z };
      const cl = dhypot3(cd.x, cd.y, cd.z) || 1;
      const cdN = { x: cd.x / cl, y: cd.y / cl, z: cd.z / cl };
      return Object.assign(pick, beamChain(world, pick.contact, cdN, pick.ballId, pick.crawlerId));
    }
    return { contact: bp };
  }
  return bestT < 1 ? { contact: at(bestT) } : null;
}
