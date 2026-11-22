import type { Vec3, PlayerState } from './types.ts';
import type { getWeaponStats } from '../../shared/weapons.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { hitRadiusAt, wakeScaleAt } from '../../shared/combat.ts';
import { segFieldHit, segPointT, segCapsuleDist, bounceOffField } from '../../shared/projSim.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { RoomProjectiles, LiveProj } from './RoomProjectiles.ts';
import { rewindPos, shooterTransitMs } from './claimLedger.ts';
import { wallNow } from './wallClock.ts';
import { dhypot3 } from '../../shared/dmath.ts';
import { renderLagOf, renderLagOfTarget, renderLagBoundOf, REWIND_MS } from './rewind.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';

type ContactHost = RoomProjectiles;

/** Shell owner as the sweeps need it: ping for transit, isBot for
 *  rewind-free reads, clientStats/aimGhosts for the drawn-ghost lane. */
type OwnerInfo = { ping: number; isBot?: boolean; clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number }; aimGhosts?: Map<string, { x: number; y: number; z: number; at: number }> } | null | undefined;

/** One body-sweep invocation - the per-candidate test rides the bag so
 *  neither the sweep nor the candidate bodyTest pays a param pile. */
interface Sweep {
  r: ContactHost;
  proj: LiveProj;
  stats: ReturnType<typeof getWeaponStats>;
  from: Vec3;
  reach: number;
  dt: number;
  owner: OwnerInfo;
}

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
    // Pierce: pay the creature and keep flying - a paid body can't be
    // re-paid next tick while the shell still sits inside its reach.
    if (stats.pierce) {
      if (proj.pierced?.has(best.id)) {return false;}
      (proj.pierced ??= new Set()).add(best.id);
      r.piercePay(proj, undefined, best === bc ? best.id : undefined, best === cc ? best.id : undefined);
      return false;
    }
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
function bodySweep(cx: Sweep): boolean {
    const {r, proj, from, reach, dt} = cx;
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
      if (bodyTry(cx, pid, target, speed)) {return true;}
    }
    return false;
  }

  /** Drawn-ghost override, shared by every sweep: a fresh aim report
   *  naming this target puts the capsule where the shooter's screen
   *  drew it - lateral DR drift lives at no rewind epoch. Reachability
   *  gate: the drawn spot must sit within drift slack of the rewind
   *  window (or live pos), so a forged claim can't score bodies the
   *  wire never visited. */
  function ghostSpot(r: ContactHost, owner: OwnerInfo, ownerId: string, pid: string, target: PlayerState, speed: number): { x: number; y: number; z: number; drawn: boolean; back: number } {
    const back = ghostBack(r, owner, ownerId, pid);
    const tp = rewindPos(target, back, r.field);
    const g = owner?.aimGhosts?.get(pid);
    if (g !== undefined && wallNow() - g.at < 300) {
      const slack = 6 + speed * (back + 250) / 1000;
      const dR = dhypot3(g.x - tp.x, g.y - tp.y, g.z - tp.z);
      const dL = dhypot3(g.x - target.position.x, g.y - target.position.y, g.z - target.position.z);
      if (dR <= slack || dL <= slack) {return { x: g.x, y: g.y, z: g.z, drawn: true, back };}
    }
    return { x: tp.x, y: tp.y, z: tp.z, drawn: false, back };
  }

  /** One candidate body: rewind/ghost the capsule, test the segment,
   *  pay pierce or detonate. true = shell consumed. */
  function bodyTry(cx: Sweep, pid: string, target: PlayerState, speed: number): boolean {
    const {r, proj, stats, from, reach, owner} = cx;
    const {p} = proj;
    const gs = ghostSpot(r, owner, proj.ownerId, pid, target, speed);
    const {back, drawn: ghostDrawn} = gs;
    const gx = gs.x, gy = gs.y, gz = gs.z;
    const cap = classCapsule(target.armorClass);
    const tp = rewindPos(target, back, r.field);
    const pc = { x: gx, y: gy + cap.centerOff, z: gz };
    const pd = segCapsuleDist(from, p.pos, pc.x, pc.y - cap.half, pc.y + cap.half, pc.z);
    // Wake is a target-side promise: grounded players only take true
    // body contact - the graze envelope (reach above bodyRadius)
    // scales with the target's feet-above-terrain, full at
    // WAKE_ALT_FULL; a field-less room can't measure alt so it pays
    // the legacy full wake.
    const scale = r.field ? wakeScaleAt(pc.y - cap.half - cap.radius - hmHeight(r.field, tp.x, tp.z)) : 1;
    const treach = stats.bodyRadius + Math.max(0, reach - stats.bodyRadius) * scale;
    // `<=` not `>`: a NaN distance must MISS like the old positive test.
    if (!(pd <= treach + cap.radius)) {return false;}
    // Pierce: pay the body and keep flying - the skewer only stops
    // for terrain, walls, and domes. The pierced set keeps the same
    // body from re-paying every tick it sits inside the capsule.
    if (stats.pierce) {
      if (proj.pierced?.has(pid)) {return false;}
      (proj.pierced ??= new Set()).add(pid);
      r.piercePay(proj, pid);
      return false;
    }
    // Ghost-forensics: how far behind live truth the credited ghost
    // sat — a large delta is the "hit landed where nobody stood" feel.
    const gd = dhypot3(gx - target.position.x, gy - target.position.y, gz - target.position.z);
    if (gd > 1.5) {logger.info('ghost hit', { shooter: proj.ownerId, victim: pid, deltaM: Number(gd.toFixed(1)), backMs: back, drawn: ghostDrawn ? 1 : 0, wt: proj.weaponType });}
    if (ghostDrawn) {r.room.health?.set('ghostDrawn', (r.room.health?.get('ghostDrawn') ?? 0) + 1);}
    // Wake contact counts as a hit but earns no airtime ramp — the
    // skillshot bonus is body-contact only, like the claim path.
    if (stats.stick) { r.attach(proj, Object.assign({}, p.pos), pid); return true; }
    r.detonate(proj, Object.assign({}, p.pos), pid, undefined, pd <= classCapsule(target.armorClass).radius + stats.bodyRadius);
    return true;
  }



export function stepContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const {p} = proj;
    // Server shells pop on first contact; the client's own bounce arc
    // diverges cosmetically, never in damage outcome.
    if (r.field && p.age >= proj.terrainAt && terrainContact(r, proj, stats, from, dt)) {return true;}
    // Wall sweep before the player check — a shell that clips a face
    // detonates there instead of phasing through to someone inside.
    // Deployable hulls contest the same lane: earliest contact wins, so
    // a generator body-blocks a shot meant for the vault wall behind it.
    if (hardContact(r, proj, stats, from, dt)) {return true;}
    // Fuse-only carriers (MRV, ClusterBomb) BOUNCE off bodies instead of
    // phasing: a thunk keeps cooking and pops wherever it lands. Contact
    // pops would make the timed airburst a strictly-better mortar — so
    // the body reflects the shell, once per body. Terrain, walls, and
    // domes above already stopped it; no damage sweep at all.
    if (stats.fuseOnly) {fuseBounce(r, proj, stats, from); return false;}
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
    return bodySweep({r, proj, stats, from, reach, dt, owner}) || creatureSweep(r, proj, stats, from, reach, owner);
  }

  /** Dirt contact: fuse bombs skip off the surface (bounce/lodge/cook-off
   *  bookkeeping lives here); everything else sticks, plants, or pops. */
  function terrainContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const {p} = proj;
    const hit = segFieldHit(from, p.pos, r.field!);
    if (!hit) {
      // Still flying below the ceiling — sweep every tick from here on.
      proj.terrainAt = 0;
      return false;
    }
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
      bounceOffField(p, r.field!, stats.bodyRadius, stats.bounceRestitution, stats.bounceFriction);
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
    // contactAge: the wire age is post-step p.age; the swept contact
    // is dt*(1-t) older in flight - stamp it or replicas read the
    // contact ~speed*dt further along the arc than it is.
    proj.contactAge = p.age - dt * (1 - segPointT(from, p.pos, hit));
    if (stats.stick) { r.attach(proj, hit); return true; }
    if (stats.plants) { r.plant(proj, hit); return true; }
    r.detonate(proj, hit); return true;
  }

  /** Static solids + deployable hulls + enemy domes: the hard-geometry
   *  lane, earliest contact wins. */
  function hardContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const {p} = proj;
    const sh = r.solids.length > 0 ? segSolidHit(from, p.pos, r.solids, r.solidIndex ?? undefined, proj.ownerTeam) : null;
    const dyn = r.room.deployables?.solidCols;
    const dh = dyn?.length ? segSolidHit(from, p.pos, dyn, undefined, proj.ownerTeam) : null;
    const hit = dh && (!sh || dh.t < sh.t) ? dh : sh;
    if (hit) { proj.contactAge = p.age - dt * (1 - hit.t); if (stats.stick) { r.attach(proj, hit); return true; } if (stats.plants) { r.plant(proj, hit); return true; } r.detonate(proj, hit); return true; }
    return shieldContact(r, proj, stats, from, dt);
  }

  /** Shield sweep — an enemy dome eats the shell at the field's edge,
   *  before any body inside can be reached. Walls already won if they
   *  hit earlier in the frame (sequential order like everything else). */
  function shieldContact(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3, dt: number): boolean {
    const {p} = proj;
    const st = r.room.deployables?.shieldBlock(from, p.pos, proj.ownerId) ?? null;
    if (st === null) {return false;}
    const at = {
      x: from.x + (p.pos.x - from.x) * st,
      y: from.y + (p.pos.y - from.y) * st,
      z: from.z + (p.pos.z - from.z) * st,
    };
    proj.contactAge = p.age - dt * (1 - st);
    if (stats.stick) { r.attach(proj, at); return true; }
    r.detonate(proj, at);
    return true;
  }

  /** Fuse-only carriers (MRV, ClusterBomb) reflect off bodies, once per
   *  body - a thunk keeps cooking and pops wherever it lands. */
  function fuseBounce(r: ContactHost, proj: LiveProj, stats: ReturnType<typeof getWeaponStats>, from: Vec3): void {
    const {p} = proj;
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
    let bestT = rayStopT(r, proj, end), hitId: string | null = null;
    const owner = r.room.players.getPlayer(proj.ownerId);
    const beam = {
      end,
      reach,
      midX: (p.pos.x + end.x) / 2, midY: (p.pos.y + end.y) / 2, midZ: (p.pos.z + end.z) / 2,
      // +0.6: the reject is off the capsule MIDPOINT — a heavy's cylinder
      // half-height (0.55) would let head/foot hits fall outside the bound.
      margin: reach + range / 2 + 0.6,
    };
    for (const [pid, target] of r.room.players.getAllPlayers()) {
      if (pid === proj.ownerId || target.isDead) {continue;}
      const t = rayBodyT(r, proj, beam, owner, pid, target);
      if (t !== null && t <= bestT) { bestT = t; hitId = pid; }
    }
    const at: Vec3 = {
      x: p.pos.x + (end.x - p.pos.x) * bestT,
      y: p.pos.y + (end.y - p.pos.y) * bestT,
      z: p.pos.z + (end.z - p.pos.z) * bestT,
    };
    // Ray reach is bodyRadius-only — any hitId here is a true body hit.
    r.detonate(proj, at, hitId, undefined, true);
  }

  /** Static-lane contacts on the beam: terrain, walls, deployable
   *  hulls, and a dome face - earliest segment parameter wins. */
  function rayStopT(r: ContactHost, proj: LiveProj, end: Vec3): number {
    const {p} = proj;
    let bestT = 1;
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
    return bestT;
  }

  /** One candidate body on the beam: midpoint reject, then the rewind/
   *  ghost capsule test. Returns the segment parameter on contact,
   *  null on a clean miss. */
  function rayBodyT(r: ContactHost, proj: LiveProj,
      beam: { end: Vec3; reach: number; midX: number; midY: number; midZ: number; margin: number },
      owner: OwnerInfo, pid: string, target: PlayerState): number | null {
    const {p} = proj;
    const gs = ghostSpot(r, owner, proj.ownerId, pid, target, dhypot3(target.velocity.x, target.velocity.y, target.velocity.z));
    const center = { x: gs.x, y: gs.y + classCapsule(target.armorClass).centerOff, z: gs.z };
    const dx = center.x - beam.midX, dy = center.y - beam.midY, dz = center.z - beam.midZ;
    if (dx * dx + dy * dy + dz * dz > beam.margin * beam.margin) {return null;}
    const cap2 = classCapsule(target.armorClass);
    if (!(segCapsuleDist(p.pos, beam.end, center.x, center.y - cap2.half, center.y + cap2.half, center.z) <= beam.reach + cap2.radius)) {return null;}
    return segPointT(p.pos, beam.end, center);
  }

