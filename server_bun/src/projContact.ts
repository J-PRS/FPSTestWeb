import type { Vec3 } from './types.ts';
import type { getWeaponStats } from '../../shared/weapons.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { hitRadiusAt } from '../../shared/combat.ts';
import { segFieldHit, segPointT, segCapsuleDist, bounceOffField } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { RoomProjectiles, LiveProj } from './RoomProjectiles.ts';
import { rewindPos, shooterTransitMs } from './claimLedger.ts';
import { dhypot3 } from '../../shared/dmath.ts';
import { renderLagOf, renderLagOfTarget, renderLagBoundOf, REWIND_MS } from './rewind.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';

type ContactHost = RoomProjectiles;

/** Rewind a body to where it sat on the shell-owner's screen: ghost =
 *  sim(t − shooterTransit − renderDelay + vel·lead), and rewind history
 *  rides the target's uplink — so back = shooterTransit + renderDelay
 *  − targetTransit (one-way hops; a full-RTT term lands ~RTT/2 behind
 *  the ghost). Creature sims keep no history — their sweeps take the
 *  shooter-side window as a backMs velocity extrapolation. */
function ghostBack(r: ContactHost, owner: { ping: number; isBot?: boolean; clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number } } | null | undefined, ownerId: string, targetId: string): number {
  // Bots read live positions — no render pipeline, no ghost to chase.
  if (owner?.isBot) {return 0;}
  const targetTransit = r.room.moveSim?.transitOf?.(targetId) ?? 0;
  // Full rewind to the shooter's reported view epoch — the client now
  // reports its ACTUAL sample staleness (viewLag, extrapolation-aware),
  // so this is the literal rendered ghost: hit what you see, hit. The
  // claim is bounded by the path the server actually measures.
  const bound = renderLagBoundOf(r.room.moveSim?.transitOf?.bind(r.room.moveSim), r.room.moveSim?.transitVarOf?.bind(r.room.moveSim), ownerId);
  return Math.max(0, shooterTransitMs(r.room.moveSim?.transitOf?.bind(r.room.moveSim), ownerId, owner?.ping ?? 0) + renderLagOfTarget(owner, targetId, bound) - targetTransit);
}

/** The body sweep tests distance to the capsule's axis MIDPOINT, so the
 *  reach must cover the cylinder half-height or a heavy's helmet/knees
 *  slip past a legal body shot. */
function capsuleCenter(t: { position: Vec3; armorClass: string }): Vec3 {
  const cap = classCapsule(t.armorClass);
  return { x: t.position.x, y: t.position.y + cap.centerOff, z: t.position.z };
}
function capsuleReach(t: { armorClass: string }, reach: number): number {
  const cap = classCapsule(t.armorClass);
  return reach + cap.half + cap.radius;
}

/** Creature sweep — server shells connect with the swarm the same way a
 *  client's creatureHit claim does: earliest ball contact along the leg. */
function creatureSweep(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, reach: number, owner: { ping: number; isBot?: boolean; clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number } } | null | undefined): boolean {
    const {p} = proj;
    // Creature sims run server-side — no uplink in their history and
    // no broadcast lead, so their ghost sits exactly shooterTransit +
    // renderDelay back.
    const backMs = owner?.isBot ? 0 : shooterTransitMs(r.room.moveSim?.transitOf?.bind(r.room.moveSim), proj.ownerId, owner?.ping ?? 0) + renderLagOf(owner, renderLagBoundOf(r.room.moveSim?.transitOf?.bind(r.room.moveSim), r.room.moveSim?.transitVarOf?.bind(r.room.moveSim), proj.ownerId));
    const bc = r.room.ballSim?.sweepHit(from, p.pos, reach, backMs);
    // Species pops contest the same lane — earliest of ball/crawler
    // contact eats the shell, so a crawler body-blocks a shot meant
    // for a ball behind it (and vice versa).
    const cc = r.room.creatureSim?.sweepHit(from, p.pos, reach, backMs);
    const best = bc && (!cc || bc.t <= cc.t) ? bc : cc;
    if (!best) {return false;}
    const at: Vec3 = {
      x: from.x + (p.pos.x - from.x) * best.t,
      y: from.y + (p.pos.y - from.y) * best.t,
      z: from.z + (p.pos.z - from.z) * best.t,
    };
    const bodyDirect = best === bc
      ? ((): boolean => { const ball = r.room.ballSim?.ballAt(bc!.id); return ball !== undefined && ball !== null && bc!.d <= ball.radius + stats.bodyRadius; })()
      : best.d <= stats.bodyRadius + 1;
    if (stats.stick) { r.attach(proj, at); return true; }
    r.detonate(proj, at, null, best === bc ? best.id : undefined, bodyDirect, best === cc ? best.id : undefined);
    return true;
  }



/** Player sweep — a cheap midpoint-sphere reject (server |vel|·dt bound
 *  plus teleport slack) skips anyone who cannot displace into reach this
 *  tick before the per-candidate segment solve runs. */
function bodySweep(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, reach: number, dt: number, owner: { ping: number; isBot?: boolean; clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number } } | null | undefined): boolean {
    const {p} = proj;
    const midX = (from.x + p.pos.x) / 2, midY = (from.y + p.pos.y) / 2, midZ = (from.z + p.pos.z) / 2;
    const halfLen = dhypot3(p.pos.x - from.x, p.pos.y - from.y, p.pos.z - from.z) / 2;
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) {continue;}
      // Teammates aren't cover: friendly damage is refused anyway, so a
      // body-block just eats the shell for nothing. friendlyFire rooms
      // keep the block (everyone is hittable there).
      if (!CONFIG.friendlyFire && proj.ownerTeam !== undefined && target.team === proj.ownerTeam) {continue;}
      const speed = dhypot3(target.velocity.x, target.velocity.y, target.velocity.z);
      // The reject only needs a bound on backMs — the rewind ceiling —
      // so ghostBack's transit/renderLag lookups wait for survivors.
      const margin = capsuleReach(target, reach) + halfLen + (speed + 25) * dt + speed * REWIND_MS / 1000;
      const center = capsuleCenter(target);
      const dx = center.x - midX, dy = center.y - midY, dz = center.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) {continue;}
      const back = ghostBack(r, owner, proj.ownerId, pid);
      const tp = rewindPos(target, back, r.field);
      const cap = classCapsule(target.armorClass);
      const pc = { x: tp.x, y: tp.y + cap.centerOff, z: tp.z };
      const pd = segCapsuleDist(from, p.pos, pc.x, pc.y - cap.half, pc.y + cap.half, pc.z);
      if (pd <= reach + cap.radius) {
        // Ghost-forensics: how far behind live truth the credited ghost
        // sat — a large delta is the "hit landed where nobody stood" feel.
        const gd = dhypot3(tp.x - target.position.x, tp.y - target.position.y, tp.z - target.position.z);
        if (gd > 1.5) {logger.info('ghost hit', { shooter: proj.ownerId, victim: pid, deltaM: Number(gd.toFixed(1)), backMs: back, wt: proj.weaponType });}
        // Wake contact counts as a hit but earns no airtime ramp — the
        // skillshot bonus is body-contact only, like the claim path.
        if (stats.stick) { r.attach(proj, Object.assign({}, p.pos), pid); return true; }
        r.detonate(proj, Object.assign({}, p.pos), pid, undefined, pd <= classCapsule(target.armorClass).radius + stats.bodyRadius);
        return true;
      }
    }
    return false;
  }



export function stepContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const {p} = proj;
    // Server shells pop on first contact; the client's own bounce arc
    // diverges cosmetically, never in damage outcome.
    if (r.field && p.age >= proj.terrainAt) {
      const hit = segFieldHit(from, p.pos, r.field);
      if (hit) {
        // Fuse bombs (grenade) bounce off dirt — the fuse is the only
        // trigger, so contact reflects the shell and stays live.
        if (stats.terrainBounce && (stats.armTime === undefined || p.age < stats.armTime)) {
          // Same contract the client's canBounce reads: an armed shell
          // pops on dirt — only the pre-arm arc skips off the surface.
          proj.bounces = (proj.bounces ?? 0) + 1;
          if (stats.maxBounces !== undefined && proj.bounces > stats.maxBounces) {
            r.detonate(proj, hit); return true;
          }
          // Lodge: first dirt contact plants the shell via the glue-bomb
          // stuck path — only the clamped fuse ends it now.
          if (stats.lodgeBounce !== undefined && proj.bounces === 1) {
            r.attach(proj, hit);
            proj.ttl = Math.min(proj.ttl, p.age + stats.lodgeBounce);
            return true;
          }
          bounceOffField(p, r.field, stats.bodyRadius, stats.bounceRestitution, stats.bounceFriction);
          if (stats.firstBounceVelScale !== undefined && proj.bounces === 1) {
            p.vel.x *= stats.firstBounceVelScale;
            p.vel.y *= stats.firstBounceVelScale;
            p.vel.z *= stats.firstBounceVelScale;
          }
          // Dirt contact starts a short cook-off when the weapon says so —
          // min-clamp keeps the first bounce's deadline on later skips.
          if (stats.fuseAfterBounce !== undefined) {proj.ttl = Math.min(proj.ttl, p.age + stats.fuseAfterBounce);}
          proj.terrainAt = 0; // still hugging the ground — keep sweeping
          return false;
        }
        if (stats.stick) { r.attach(proj, hit); return true; }
        r.detonate(proj, hit); return true;
      }
      // Still flying below the ceiling — sweep every tick from here on.
      proj.terrainAt = 0;
    }
    // Wall sweep before the player check — a shell that clips a face
    // detonates there instead of phasing through to someone inside.
    // Deployable hulls contest the same lane: earliest contact wins, so
    // a generator body-blocks a shot meant for the vault wall behind it.
    {
      const sh = r.solids.length > 0 ? segSolidHit(from, p.pos, r.solids, r.solidIndex ?? undefined, proj.ownerTeam) : null;
      const dyn = r.room.deployables?.solidCols;
      const dh = dyn?.length ? segSolidHit(from, p.pos, dyn, undefined, proj.ownerTeam) : null;
      const hit = dh && (!sh || dh.t < sh.t) ? dh : sh;
      if (hit) { if (stats.stick) { r.attach(proj, hit); return true; } r.detonate(proj, hit); return true; }
    }
    // Shield sweep — an enemy dome eats the shell at the field's edge,
    // before any body inside can be reached. Walls already won if they
    // hit earlier in the frame (sequential order like everything else).
    const st = r.room.deployables?.shieldBlock(from, p.pos, proj.ownerId) ?? null;
    if (st !== null) {
      const at = {
        x: from.x + (p.pos.x - from.x) * st,
        y: from.y + (p.pos.y - from.y) * st,
        z: from.z + (p.pos.z - from.z) * st,
      };
      if (stats.stick) { r.attach(proj, at); return true; }
      r.detonate(proj, at);
      return true;
    }
    // Fuse-only carriers (MRV, ClusterBomb) BOUNCE off bodies instead of
    // phasing: a thunk keeps cooking and pops wherever it lands. Contact
    // pops would make the timed airburst a strictly-better mortar — so
    // the body reflects the shell, once per body. Terrain, walls, and
    // domes above already stopped it; no damage sweep at all.
    if (stats.fuseOnly) {
      const e = stats.bounceRestitution ?? 0.5;
      for (const [pid, target] of r.room.players.getAllPlayers()) {
        if (pid === proj.ownerId || target.isDead || proj.bodyBounced?.has(pid)) {continue;}
        const cap = classCapsule(target.armorClass);
        const center = capsuleCenter(target);
        const pc = { x: center.x, y: center.y, z: center.z };
        const pd = segCapsuleDist(from, p.pos, pc.x, pc.y - cap.half, pc.y + cap.half, pc.z);
        if (pd <= cap.radius + stats.bodyRadius + 0.3) {
          const nx = p.pos.x - pc.x, ny = p.pos.y - pc.y, nz = p.pos.z - pc.z;
          const nl = dhypot3(nx, ny, nz) || 1;
          const d = (p.vel.x * nx + p.vel.y * ny + p.vel.z * nz) / nl;
          if (d < 0) {
            p.vel.x -= (1 + e) * d * nx / nl;
            p.vel.y -= (1 + e) * d * ny / nl;
            p.vel.z -= (1 + e) * d * nz / nl;
          }
          (proj.bodyBounced ??= new Set()).add(pid);
        }
      }
      return false;
    }
    // Arming fuse (T2 mortar): bodies phase through until the shell is
    // armed — terrain, walls, and domes above already stopped it. GL
    // overrides with bodyArmTime=0: its shells bounce off dirt yet pop
    // on a body at any age. Client gates the same sweeps on bodiesLive.
    const bodyArm = stats.bodyArmTime ?? stats.armTime;
    if (bodyArm !== undefined && p.age < bodyArm) {return false;}
    // Player sweep — same legal radius the hit-claim validator allows:
    // the target's class radius (in capsuleReach) + the larger of
    // body/wake radius at this airtime.
    const reach = Math.max(stats.bodyRadius, hitRadiusAt(proj.weaponType, p.age));
    const owner = r.room.players.getPlayer(proj.ownerId);
    return bodySweep(r, proj, stats, from, reach, dt, owner) || creatureSweep(r, proj, stats, from, reach, owner);
  }

  /** Fire the shell's hitscan beam along its velocity line. Order of
   *  contacts decides the blast point: nearest wins between terrain and
   *  players, so a beam that clips a ridge never splashes past it. */
export function dischargeRay(r: ContactHost, proj: LiveProj, range: number): void {
    const {p} = proj;
    const speed = dhypot3(p.vel.x, p.vel.y, p.vel.z) || 1;
    const end: Vec3 = {
      x: p.pos.x + (p.vel.x / speed) * range,
      y: p.pos.y + (p.vel.y / speed) * range,
      z: p.pos.z + (p.vel.z / speed) * range,
    };
    const reach = proj.stats.bodyRadius;
    // Track the earliest contact as a segment parameter [0..1].
    let bestT = 1, hitId: string | null = null;
    if (r.field) {
      const th = segFieldHit(p.pos, end, r.field);
      if (th) {bestT = segPointT(p.pos, end, th);}
    }
    if (r.solids.length > 0) {
      const sh = segSolidHit(p.pos, end, r.solids, r.solidIndex ?? undefined, proj.ownerTeam);
      if (sh) {bestT = Math.min(bestT, segPointT(p.pos, end, sh));}
    }
    const dcols = r.room.deployables?.solidCols;
    if (dcols?.length) {
      const dh = segSolidHit(p.pos, end, dcols, undefined, proj.ownerTeam);
      if (dh) {bestT = Math.min(bestT, segPointT(p.pos, end, dh));}
    }
    // A dome eats the discharged beam too — same rule as flight contact.
    const sht = r.room.deployables?.shieldBlock(p.pos, end, proj.ownerId) ?? null;
    if (sht !== null) {bestT = Math.min(bestT, sht);}
    const owner = r.room.players.getPlayer(proj.ownerId);
    const midX = (p.pos.x + end.x) / 2, midY = (p.pos.y + end.y) / 2, midZ = (p.pos.z + end.z) / 2;
    // +0.6: the reject is off the capsule MIDPOINT — a heavy's cylinder
    // half-height (0.55) would let head/foot hits fall outside the bound.
    const margin = reach + range / 2 + 0.6;
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) {continue;}
      const tp = rewindPos(target, ghostBack(r, owner, proj.ownerId, pid), r.field);
      const center = { x: tp.x, y: tp.y + classCapsule(target.armorClass).centerOff, z: tp.z };
      const dx = center.x - midX, dy = center.y - midY, dz = center.z - midZ;
      if (dx * dx + dy * dy + dz * dz > margin * margin) {continue;}
      const t = segPointT(p.pos, end, center);
      const cap2 = classCapsule(target.armorClass);
      if (t <= bestT && segCapsuleDist(p.pos, end, center.x, center.y - cap2.half, center.y + cap2.half, center.z) <= reach + cap2.radius) { bestT = t; hitId = pid; }
    }
    const at: Vec3 = {
      x: p.pos.x + (end.x - p.pos.x) * bestT,
      y: p.pos.y + (end.y - p.pos.y) * bestT,
      z: p.pos.z + (end.z - p.pos.z) * bestT,
    };
    // Ray reach is bodyRadius-only — any hitId here is a true body hit.
    r.detonate(proj, at, hitId, undefined, true);
  }

