/**
 * roomInfo - the MessageHandler's RoomInfo table, built from a Room.
 * Four groups: base identity/spec, ping/nack/reconnect plumbing, the
 * binary-wire + claim-verb surface, and the proximity/authority reads.
 * Extracted from Room.ts 2026-11-22 - members it reads that were
 * private (lastNackAt, lastPingStamp, beamSweep, deployGate,
 * applyClassScale) are package-visible on Room for this module.
 */
import type { Room } from './Room.ts';
import type { RoomInfo } from './MessageHandler.ts';
import type { BeamContact } from './CombatHandler.ts';
import type { ServerMessage, RoomMods } from '../../shared/protocol.ts';
import { ENERGY } from '../../shared/movement.ts';
import { encodeHit } from '../../shared/wire.ts';
import { wallNow } from './wallClock.ts';
import { simNow } from './simClock.ts';
import { CONFIG } from './config.ts';

export function buildRoomInfo(room: Room, roomName: string): RoomInfo {
  // Object.assign, not spread: oxc bans rest-spread properties, and
  // the merged Partial needs the one cast on the way out anyway.
  return Object.assign(infoBase(room, roomName), infoPing(room), infoWire(room), infoCombat(room)) as RoomInfo;
}

function infoBase(room: Room, roomName: string): Partial<RoomInfo> {
  return {
    room: roomName,
    mode: room.mode,
    // Live reader, not a snapshot: roomFactory flips these flags on
    // reused Rooms after this RoomInfo was captured.
    mods: (): RoomMods => room.mods,
    // This authority sims every outcome  -  no client claim is legitimate.
    claimsAccepted: false,
    scores: room.scores,
    teams: room.modeSpec?.teams,
    friendlyFire: CONFIG.friendlyFire,
    winAt: room.modeSpec?.winAt,
    ffaScores: (): { [k: string]: number; } => Object.fromEntries(room.scoring.ffaScores),
    // Registry stores playerId->u16; the wire roster ships the
    // inverse so receivers resolve a frame's u16 to an identity.
    wireIds: (): { [x: number]: string; } => {
      const out: Record<number, string> = {};
      for (const [pid, id] of room.wireIds) {out[id] = pid;}
      return out;
    },
    idOfWid: (wid): string | undefined => room.widToId.get(wid),
    simsWorldState: (): ServerMessage[] => room.sims.flatMap((s): ServerMessage[] => s.worldState?.() ?? []),
    bases: room.spec.bases,
    structures: room.structs.eff(),
    arena: room.spec.arena,
    killY: room.spec.killY,
    ambient: room.spec.ambient,
    // Authored spec title wins; the maps/<X>.json source filename is the
    // fallback  -  set post-ctor by the factory, refreshed by rotation.
    mapName: (): string | undefined => room.spec.name ?? (room.mapSrc || undefined),
    // Effective spawn pools, live-read: mode modules re-mint spheres
    // mid-match (conquest node rings)  -  the spec's authored copy is stale.
    spawns: () => room.players.spawnPoints,
    teamSpawns: () => room.players.teamSpawns,
    terrain: room.spec.terrain,
    heightScale: room.spec.heightScale,
    tileSize: room.spec.tileSize,
    fog: room.spec.fog,
    water: room.spec.water,
    terrainTex: room.spec.terrainTex,
    terrainPreset: room.spec.terrainPreset,
    sky: room.spec.sky,
    weather: room.spec.weather,
    atmosphere: room.spec.atmosphere,
    interiors: room.spec.interiors,
    emit: room.events.emit,
    rng: (): number => room.rng(),
    flags: () => room.flags?.snapshot() ?? [],
    pickups: () => room.pickups?.snapshot() ?? [],
  };
}

/** Ping/nack/reconnect-window closures of the handler table (split
 *  for the line-count ratchet - the merged literal casts back to
 *  RoomInfo since Partial spreads cannot prove required fields). */
function infoPing(room: Room): Partial<RoomInfo> {
  return {
    // tickNack: reuse the introSeq full-window  -  every record goes full
    // for ~1s, which reseeds every client's baselines whether they
    // nacked or not (records are shared; scoping per-socket isn't
    // possible without per-socket encodes). 500ms room cooldown so a
    // nack-storm can't hold the room on fulls permanently.
    drainedForTicks: (pid): boolean => room.connections.drainedForTicks(pid),
    // A spectator's gap is scoped to their own intro window  -  spec
    // count is unbounded, so room-wide fulls per spec nack would be an
    // amplifier. Player nacks still take nackFulls (their basis
    // corruption is ambiguous, so everyone reseeds).
    nackFor: (pid): boolean => {
      if (!room.spectators.has(pid)) {return false;}
      // Re-arm cap: a spec nack storm would otherwise hold introPending
      // true forever  -  every record double-encodes rec.full at 20Hz
      // permanently. An open window still paying out covers the nack.
      if (room.tickSeq - (room.introPlayers.get(pid) ?? -100) < 20) {return true;}
      room.markIntro(pid);
      return true;
    },
    isSpectator: (pid): boolean => room.spectators.has(pid),
    nackFulls: (): void => {
      const now = wallNow();
      if (now - room.lastNackAt < 500) {return;}
      // A window still paying out covers every client  -  re-stamping
      // would let a nack every 500ms hold the room on fulls forever.
      if (room.tickSeq - room.introSeq < 20) {return;}
      room.lastNackAt = now;
      room.introSeq = room.tickSeq;
    },
    readySpawn: (pid): void => room.releaseReady(pid),
    admitQueue: (pid, ids): void => { room.admitPending.set(pid, ids); },
    floodPause: (pid, ms): void => room.connections.floodPause(pid, ms),
    // oxlint-disable-next-line max-params -- RoomInfo.fireProjectile's signature is interface-mandated
    fireProjectile: (pid, wt, origin, dir, vel, shotId, lagS, dmgMult, variant): string | null => room.projectiles.spawn(pid, wt, origin, dir, vel, shotId, lagS, dmgMult, variant),
    fizzleProjectiles: (pid): void => room.projectiles.fizzleOwner(pid),
    ghostSweep: (pid, victimId, pt): void => room.projectiles.ghostLateSweep(pid, victimId, pt),
    // oxlint-disable-next-line max-params -- RoomInfo.beamSweep's signature is interface-mandated
    beamSweep: (pid, muzzle, dir, range, includeTeammates, snapPad, coneCos2): BeamContact | null => room.beamSweep(pid, muzzle, dir, range, includeTeammates, snapPad, coneCos2),
    ballHit: (pid, id, dmg) => room.ballSim.handleHit(pid, id, dmg),
    crawlerHit: (pid, id, dmg) => room.creatureSim.handleHit(pid, id, dmg),
    repairTarget: (pid, muz, dir, range): number | null => room.deployables.repairTarget(pid, muz, dir, range),
    onDeploy: (pid, kind, pos, vel): string | true => room.deployGate(pid, kind, pos, vel),
    onRepair: (pid, targetId): string | true => room.deployables.repair(pid, targetId),
    deployables: () => room.deployables.snapshot(),
    influence: room.influence,
    matchEndsAt: (): number => room.matchClock.timeLeftMs() > 0 ? simNow() + room.matchClock.timeLeftMs() : 0,
    moveInput: (pid, i, status, seq, ageMs): boolean => room.moveSim.queueInput(pid, {
      forward: i.forward, right: i.right,
      jumpPressed: Boolean(i.jump), jumpHeld: Boolean(i.jump), skiHeld: Boolean(i.ski),
      jetHeld: Boolean(i.jet),
    }, status, seq, ageMs),
    moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => room.moveSim.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
    inputSeqOf: (pid): number => room.moveSim.inputSeqOf(pid),
    transitOf: (pid): number => room.moveSim.transitOf(pid),
    transitVarOf: (pid): number => room.moveSim.transitVarOf(pid),
    transitNote: (pid, rtt, stamp): void => {
      if (room.lastPingStamp.get(pid) !== stamp) {return;}
      room.moveSim.feedTransit(pid, rtt);
      // Echo the server-measured RTT back  -  the client's own ping/pong
      // number includes its event-loop stall, so the pair reads as
      // "client/server" and splits a busy renderer from a slow wire.
      room.sendToPlayer(pid, { type: 'srvPing', rtt });
    },
    uplinkNote: (pid, fireAt): void => {
      // (arrival − declared instant) is this claim's uplink transit  -
      // bounded so a wildly off clock (or forged stamp) degrades to the
      // ping/pong channel instead of poisoning the EMA.
      const uplink = wallNow() - fireAt;
      // Bias sampling tolerates negative uplink: a client clock that
      // runs ahead stamps "future" fireAt, and that IS the offset the
      // instrument exists to expose. The transit EMA still only eats
      // plausible samples inside feedUplink.
      if (uplink >= -1000 && uplink <= 2000) {room.moveSim.feedUplink(pid, uplink);}
      else {room.healthBump(uplink < -1000 ? 'uplink.farneg' : 'uplink.farpos');}
    },
  };
}

/** Binary-wire + claim-verb closures of the handler table. */
function infoWire(room: Room): Partial<RoomInfo> {
  return {
    // playerHit on the binary lane: one encodeHit per event rides the
    // same batch as the tick frame  -  ~20B vs ~160B JSON, the client's
    // own wireIds map resolves ids back. 'environment' encodes wid 0.
    wireHit: (e): boolean => {
      const targetWid = room.wireIds.get(e.targetId);
      if (targetWid === undefined) {return false;}
      const shooterWid = e.shooterId === 'environment' ? 0 : room.wireIds.get(e.shooterId);
      if (shooterWid === undefined) {return false;}
      if (e.shooterId !== 'environment') {room.noteEngagement(e.shooterId, e.targetId);}
      room.connections.broadcastBinaryReliable(encodeHit(Object.assign({}, e, { targetWid, shooterWid })), 'volatile'); // combat events journal  -  same 3s staleness window the JSON lane carried
      return true;
    },
    // Generic S→C binary relay plumbing  -  the wireId+pos event family
    // encodes at the emit site and rides the same batch/journal lanes.
    widOf: (pid): number | undefined => room.wireIds.get(pid),
    wireCast: (data, journaled, exclude): void => room.connections.broadcastBinaryReliable(data, journaled, exclude),
    wireTo: (pid, data, journaled): void => room.connections.sendBinToPlayerReliable(pid, data, journaled),
    earlyRelayed: (pid, shotId): boolean => room.earlyRelayed(pid, shotId),
    gunRungOf: (pid): number => room.gunRungOf(pid),
    gunGameHeld: (pid, wt): void => room.gunGameHeld(pid, wt),
    // The rabbit dep's presence IS the mode check  -  CombatHandler gates
    // all PvP damage on the carrier being one side of the pair.
    rabbitCarrier: room.mode === 'rabbit' ? (): string | null => room.flags?.carrierId() ?? null : undefined,
    rabbitFlagLive: room.mode === 'rabbit' ? (): boolean => room.flags?.spawned() ?? false : undefined,
    rabbitBottom: room.mode === 'rabbit' ? (): Set<string> => room.scoring.bottomFeeders() : undefined,
    drainEnergy: (pid, n): boolean => room.moveSim.drainEnergy(pid, n),
    // Blast occlusion through enemy domes  -  a shell detonating at the
    // shield's edge can't splash victims inside it.
    shieldBlocked: (from, to, shooterId): boolean =>
      room.deployables.shieldedPoint(to, shooterId, from),
    // Instant-skill claim: the client already spent the energy locally  -
    // mirror the same ante on the shadow or the tank drifts 50 apart.
    onSkillUse: (pid, skill): true | "gone" => {
      const p = room.players.getPlayer(pid);
      if (!p) {return 'gone';}
      // Identity check: a claim naming a skill the seat never declared
      // is a forged press  -  declared skills are the only legal ones.
      // A seat with NO declared skill has nothing legal to press at
      // all; accepting there would stamp lastSkillUse and open the
      // authority teleport window without a real beacon.
      if (p.skill === undefined || (skill !== undefined && skill !== p.skill)) {return 'gone';}
      // Cooldown floor: client skills all sit at 1s; 850ms of slack
      // eats jitter, a faster claim is a script.
      const now = wallNow();
      if (p.lastSkillUse !== undefined && now - p.lastSkillUse < 850) {return 'gone';}
      if (!room.moveSim.drainEnergy(pid, ENERGY.skillCost)) {return 'gone';}
      p.lastSkillUse = now;
      return true;
    },
    onThrowFlag: (pid): void | undefined => room.flags?.throwFor(pid),
    energyOf: (pid): number | null => room.moveSim.energyOf(pid),
    groundedOf: (pid): boolean => room.moveSim.simState(pid)?.onGround ?? false,
    // Wire-invisible cloak predicate - same terms as the tickRecords
    // hidden flag: masked CLOAK claim, modeled tank alive, shoot-
    // reveal window closed (lastFireSim is sim-ms domain).
    cloakHidden: (pid): boolean => room.cloakHiddenOf(pid),
    moveResync: (pid, pos, yaw, fullEnergy): void => {
      room.moveSim.resync(pid, pos, yaw, fullEnergy);
      // Resync re-anchors the shadow  -  also refresh the class speed
      // scale so a respawn-applied tier swap propagates (moveTrack
      // only re-reads it at handshake).
      room.applyClassScale(pid);
    },
    moveTrack: (pid, pos, yaw): void => {
      const p = room.players.getPlayer(pid);
      room.moveSim.track(pid, pos, yaw, { perk: p?.perk, team: p?.team, bot: p?.isBot, armorClass: p?.armorClass });
      // Re-seats (room hop) have stale position frames in flight  -  arm
      // the same grace resync() uses so they can't seed the fresh
      // shadow at the old seat and flag the real spawn landing a cheat.
      room.moveSim.markReseated(pid);
      room.applyClassScale(pid);
    },
    moveMute: (pid): void => room.moveSim.markReseated(pid),
    moveUntrack: (pid): void => {
      room.moveSim.untrack(pid);
      room.lastPingStamp.delete(pid);
    },
    // A spoken line is itself an event worth a reply  -  the squad sees
    // it on their own think phases, so an answer (if any) lands a beat
    // later like real chat, not a scripted call-and-response.

    moveAuthority: (): boolean => room.moveAuthority,
  };
}

/** Proximity/authority closures of the handler table. */
function infoCombat(room: Room): Partial<RoomInfo> {
  return {
    health: room.health,
    envRange: (pid): number => {
      const p = room.players.getPlayer(pid);
      if (!p) {return Infinity;}
      // Crawlers count too  -  envDamage legitimately comes from bites,
      // not just balls; a balls-only check warned on every true pounce.
      let d = room.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z);
      for (const c of room.creatureSim.crawlers.values()) {
        if (c.dead) {continue;}
        const dc = Math.hypot(c.x - p.position.x, c.y - p.position.y, c.z - p.position.z);
        if (dc < d) {d = dc;}
      }
      // Mines/turrets count too  -  an untagged blastAtPlayer claim from a
      // tripped mine has no creature near, only the hull it stood next to.
      for (const dep of room.deployables.items.values()) {
        const dd = Math.hypot(dep.pos.x - p.position.x, dep.pos.y - p.position.y, dep.pos.z - p.position.z);
        if (dd < d) {d = dd;}
      }
      return d;
    },
    preyNear: (pos, shooterId): { ball: number; crawler: number; foe: number; } => {
      let crawler = Infinity;
      for (const c of room.creatureSim.crawlers.values()) {
        const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
        if (d < crawler) {crawler = d;}
      }
      // Nearest enemy body to the pop  -  a foe eating the shell at 5m
      // reads as a 'lip' in the autopsy otherwise, masking body
      // intercepts as terrain clips.
      const team = shooterId ? room.players.getPlayer(shooterId)?.team : undefined;
      let foe = Infinity;
      for (const q of room.players.getAllPlayers().values()) {
        if (q.id === shooterId || q.isDead || (team && q.team === team)) {continue;}
        const d = Math.hypot(q.position.x - pos.x, q.position.y - pos.y, q.position.z - pos.z);
        if (d < foe) {foe = d;}
      }
      return { ball: room.ballSim.nearestBallDist(pos.x, pos.y, pos.z), crawler, foe };
    },
  };
}
