// WIRE — the client→server message contract as ONE table. A new message
// type is a single entry here: its validator (wire bytes → typed msg),
// its rate limit (omit for the shared default bucket), and its room
// handler. Validation happens pre-room (GameServer.validate), the limit
// and handler run inside the room's command drain at tick phase 0.
//
// 'join' has an entry only for the retry path — the handshake itself is
// sessions.handle's job. 'switchRoom' validates here but is intercepted
// by GameServer before room dispatch, so it carries no handle.

import {
  type ValidationResult,
  isFiniteNumber,
  word,
  validateVec3,
  validateRotation,
  validateBody,
  optVec,
  optProjId,
  optProjIdOpt,
  optShotId,
  optClaimSeq,
} from './validation.ts';
import type { ClientMessage } from './types.ts';
import type { MessageHandler } from './MessageHandler.ts';
import { DEPLOY_KINDS, type DeployKind } from '../../shared/deployables.ts';
import { isPerkId } from '../../shared/perks.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import { wallNow } from './wallClock.ts';

/** weaponType is a claim the cadence law and belt costs key off — an
 *  out-of-table index skips every per-weapon gate while getWeaponStats
 *  silently defaults to BoltLauncher. Unknown ids are malformed, period. */
const optWeaponType = (v: unknown): { ok: boolean; v?: number } => {
  if (v === undefined) {return { ok: true };}
  if (Number.isInteger(v) && (v as number) in WEAPONS) {return { ok: true, v: v as number };}
  return { ok: false };
};

export interface RateLimit {
  maxCount: number;
  windowMs: number;
  /** T2-style flood control: exceeding maxCount mutes the type for this
   *  long — not just drops within the window, a real timeout. */
  muteMs?: number;
}

export interface WireEntry<K extends ClientMessage['type']> {
  validate(obj: Record<string, unknown>): ValidationResult<Extract<ClientMessage, { type: K }>>;
  limit?: RateLimit;
  handle?: (h: MessageHandler, id: string, m: Extract<ClientMessage, { type: K }>) => void;
}

/** Types without their own bucket share this one. */
export const WIRE_DEFAULT_LIMIT: RateLimit = { maxCount: 120, windowMs: 1000 };

const parseEdge = (raw: unknown): { seq?: number; ageMs?: number; input: { forward: number; right: number; jump: number; ski: number; jet: number; status: number }; rotation: { yaw: number; pitch: number } } | string => {
  const input = (raw as Record<string, unknown>)?.input;
  if (typeof input !== 'object' || input === null) {return 'input must be an object';}
  const i = input as Record<string, unknown>;
  if (!isFiniteNumber(i.forward) || !isFiniteNumber(i.right) || !isFiniteNumber(i.jump) || !isFiniteNumber(i.ski)) {
    return 'input fields must be finite numbers';
  }
  const rot = validateRotation((raw as Record<string, unknown>).rotation);
  if (!rot.success) {return `rotation: ${rot.error}`;}
  return {
    seq: isFiniteNumber((raw as Record<string, unknown>).seq) ? (raw as Record<string, unknown>).seq as number : undefined,
    ageMs: isFiniteNumber((raw as Record<string, unknown>).ageMs) ? (raw as Record<string, unknown>).ageMs as number : undefined,
    input: { forward: i.forward, right: i.right, jump: i.jump, ski: i.ski, jet: isFiniteNumber(i.jet) ? i.jet : 0, status: isFiniteNumber(i.status) ? i.status : 0 },
    rotation: rot.data,
  };
};

export const WIRE: { [K in ClientMessage['type']]?: WireEntry<K> } = {
  // The handshake join never reaches a room — but a RETRY does: a client
  // whose gameState reply was lost resends join on an already-seated
  // socket. Resending world state heals that loop silently; a join
  // naming a different playerId can't re-seat a live socket, so it dies
  // here instead of warn-spamming every drained retry.
  join: {
    // Retry headroom matters: a flapping client resends join while its
    // gameState never lands — dropping retry #5 starves the very heal
    // it's asking for (the WAN-flap "connected but never seated" stall).
    limit: { maxCount: 10, windowMs: 10_000 },
    validate: (obj) => typeof obj.playerId === 'string'
      ? { success: true, data: (Object.assign({}, obj, {type: 'join' as const,playerId: obj.playerId})) as Extract<ClientMessage, { type: 'join' }> }
      : { success: false, error: 'join missing playerId' },
    handle: (h, id, m): void => {
      if (m.playerId === id) {h.sendWorldState(id);}
    },
  },

  // tickNack: the client detected a tickSeq gap on the lossy lane —
  // answer with a full-record window (Room.nackFulls, room-cooldowned).
  // Limit is per-player flood control; the real cap is the room one.
  tickNack: {
    limit: { maxCount: 4, windowMs: 1000 },
    validate: (obj) => obj.type === 'tickNack'
      ? { success: true, data: { type: 'tickNack' } as Extract<ClientMessage, { type: 'tickNack' }> }
      : { success: false, error: 'tickNack malformed' },
    handle: (h, id): void | undefined => {
      // A nack from a still-gated client is noise, not loss: its gaps
      // come from the intro hold by design, its decode basis reseeds on
      // the intro fulls, and stamping introSeq here would grow the very
      // join burst the gate is waiting on.
      if (h.roomInfo.drainedForTicks?.(id) === false) {return;}
      // A spectator's gap is theirs alone — scope the reseed to their own
      // intro window instead of forcing room-wide fulls (spec count is
      // unbounded relative to players, so a nacking spec fleet would be a
      // full-record amplifier).
      if (h.roomInfo.nackFor?.(id) === true) {return;}
      return h.roomInfo.nackFulls?.();
    },
  },

  position: {
    limit: { maxCount: 30, windowMs: 1000 },
    // oxlint-disable-next-line typescript/no-explicit-any -- decode boundary: validated payloads flow out as any by design
    validate: (obj): { success: false; error: string; } | { success: true; data: any; } => {
      const body = validateBody(obj);
      if (!body.success) {return body;}
      const seq = isFiniteNumber(obj.seq) ? obj.seq : undefined;
      const inputSeq = isFiniteNumber(obj.inputSeq) ? obj.inputSeq : undefined;
      const ping = isFiniteNumber(obj.ping) ? obj.ping : undefined;
      // Held input piggybacks on volatile frames — optional, validated
      // like inputMove's fields, dropped silently when malformed.
      let input: { forward: number; right: number; jump: number; ski: number; jet: number } | undefined = undefined;
      const rawInput = obj.input;
      if (typeof rawInput === 'object' && rawInput !== null) {
        const i = rawInput as Record<string, unknown>;
        if (isFiniteNumber(i.forward) && isFiniteNumber(i.right) && isFiniteNumber(i.jump) && isFiniteNumber(i.ski)) {
          input = { forward: i.forward, right: i.right, jump: i.jump, ski: i.ski, jet: isFiniteNumber(i.jet) ? i.jet : 0 };
        }
      }
      return { success: true, data: Object.assign({}, body.data, {seq,inputSeq,ping}, (input ? { input } : {}), {type: 'position' as const}) };
    },
    handle: (h, id, m): void => h.moves.handlePosition(id, m),
  },

  teleport: {
    // NO rate limit on purpose: teleport is a declared discontinuity the
    // client already applied locally — silently dropping it doesn't stop
    // the warp, it just converts it into pos-reject ping-pong + an event
    // observers never see. Anti-spam lives in handleTeleport's violation
    // counter (teleportSpam) instead, which honors-and-counts rather than
    // drop-and-desync.
    validate: (obj) => {
      const body = validateBody(obj);
      if (!body.success) {return body;}
      return { success: true, data: Object.assign({}, body.data, {type: 'teleport' as const}) };
    },
    handle: (h, id, m): void => h.moves.handleTeleport(id, m),
  },

  aoeShot: {
    // All AOE weapons share one bucket — GL spam is the ceiling it guards,
    // but the floor is the Lightning beam: ~22 on-target ticks/s, so a held
    // beam + a GL volley legitimately runs ~24/s. 30 leaves the flood gate
    // in place without eating honest beam ticks.
    limit: { maxCount: 30, windowMs: 1000 },
    validate: (obj) => {
      const pos = validateVec3(obj.position);
      if (!pos.success) {return { success: false, error: `position: ${pos.error}` };}
      const {excludeTargetId} = obj;
      if (excludeTargetId !== null && excludeTargetId !== undefined && typeof excludeTargetId !== 'string') {
        return { success: false, error: 'excludeTargetId must be string or null' };
      }
      const wt = optWeaponType(obj.weaponType);
      if (!wt.ok) {return { success: false, error: 'weaponType: unknown weapon' };}
      const pid = optProjIdOpt(obj.projectileId);
      if (!pid.ok) {return { success: false, error: 'projectileId: oversized' };}
      return {
        success: true,
        data: {
          type: 'aoeShot',
          position: pos.data,
          weaponType: wt.v,
          excludeTargetId: (excludeTargetId as string | null) ?? null,
          projectileId: pid.v,
          airtime: isFiniteNumber(obj.airtime) ? obj.airtime : undefined,
          power: isFiniteNumber(obj.power) ? obj.power : undefined,
          directHit: obj.directHit === true ? true : undefined,
          shotId: optShotId(obj.shotId),
          claimSeq: optClaimSeq(obj.claimSeq),
          fireAt: isFiniteNumber(obj.fireAt) ? obj.fireAt : undefined,
        },
      };
    },
    handle: (h, id, m): void => {
      if (h.acceptClaims === false) { h.claimAck(id, 'aoeShot', m.claimSeq, 'outcomes are server-simmed'); return; }
      h.combat.handleAOEShot(id, m);
    },
  },

  shotFired: {
    // Cosmetic relay, but every claim fans out to the room — an uncapped
    // flood is free egress amplification. One per trigger pull, so the
    // legal ceiling is the shot cadence itself.
    limit: { maxCount: 40, windowMs: 1000 },
    validate: (obj) => {
      const dir = optVec(obj.dir);
      if (!dir.ok) {return { success: false, error: `dir: ${dir.error}` };}
      const wt = optWeaponType(obj.weaponType);
      if (!wt.ok) {return { success: false, error: 'weaponType: unknown weapon' };}
      const pos = optVec(obj.pos);
      if (!pos.ok) {return { success: false, error: `pos: ${pos.error}` };}
      const svel = optVec(obj.vel);
      return {
        success: true,
        data: {
          type: 'shotFired',
          weaponType: wt.v,
          dir: dir.ok ? dir.data : undefined,
          pos: pos.ok ? pos.data : undefined,
          vel: svel.ok ? svel.data : undefined,
          shotId: optShotId(obj.shotId),
          fireAt: isFiniteNumber(obj.fireAt) ? obj.fireAt : undefined,
        },
      };
    },
    handle: (h, id, m): void => h.combat.handleShotFired(id, m),
  },

  slam: {
    // One landing per skill dive — a real player can't land twice a
    // second; the gate exists because every slam runs a blast sweep.
    limit: { maxCount: 6, windowMs: 1000 },
    validate: (obj) => {
      const pos = validateVec3(obj.position);
      if (!pos.success) {return { success: false, error: `position: ${pos.error}` };}
      return { success: true, data: { type: 'slam', position: pos.data, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => h.claimAck(id, 'slam', m.claimSeq, h.combat.handleSlam(id, m)),
  },

  jump: {
    limit: { maxCount: 10, windowMs: 1000 },
    validate: (obj) => {
      const pos = validateVec3(obj.position);
      if (!pos.success) {return { success: false, error: `position: ${pos.error}` };}
      return { success: true, data: { type: 'jump', position: pos.data } };
    },
    handle: (h, id, m): void => h.relayPresenceEvent(id, m),
  },

  jetpack: {
    limit: { maxCount: 60, windowMs: 1000 },
    validate: (obj) => {
      const pos = validateVec3(obj.position);
      if (!pos.success) {return { success: false, error: `position: ${pos.error}` };}
      return { success: true, data: { type: 'jetpack', position: pos.data } };
    },
    handle: (h, id, m): void => h.relayPresenceEvent(id, m),
  },

  inputMove: {
    limit: { maxCount: 120, windowMs: 1000 },
    validate: (obj) => {
      const edge = parseEdge(obj);
      if (typeof edge === 'string') {return { success: false, error: edge };}
      // prev is optional redundancy: same shape, validated the same —
      // a malformed copy must not sink the good current edge though, so
      // it fails soft (dropped, not rejected).
      let prev: typeof edge | undefined = undefined;
      if (obj.prev != null) {
        const pe = parseEdge(obj.prev);
        if (typeof pe !== 'string') {prev = pe;}
      }
      return { success: true, data: Object.assign({}, edge, {prev,type: 'inputMove' as const}) };
    },
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      if (!p || p.isDead) {return;}
      const apply = (e: { seq?: number; ageMs?: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number } }): boolean => {
        const i = e.input;
        const newStatus = (i.status ?? 0) & CLIENT_STATUS_MASK;
        // Stale edges must not touch skiing/status either — the sim's
        // seq gate decides before we commit.
        if (h.roomInfo.moveInput?.(id, i, newStatus, e.seq, e.ageMs) === false) {return false;}
        p.skiing = i.ski ? 1 : 0;
        p.jetting = i.jet ? 1 : 0;
        p.status = newStatus;
        return true;
      };
      // Redundant copy first: a lost packet's edge lands here instantly
      // instead of waiting the watchdog round-trip. seq gates inside
      // moveInput keep the double-apply a no-op on the happy path.
      if (m.prev) {apply(m.prev);}
      apply(m);
    },
  },

  projectileDestroy: {
    limit: { maxCount: 30, windowMs: 1000 },
    validate: (obj) => {
      const pid = optProjId(obj.projectileId);
      if (!pid.ok) {
        return { success: false, error: 'projectileId: invalid or oversized' };
      }
      return { success: true, data: { type: 'projectileDestroy', projectileId: pid.v!, shotId: optShotId(obj.shotId), claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => {
      if (h.acceptClaims === false) { h.claimAck(id, 'projectileDestroy', m.claimSeq, 'outcomes are server-simmed'); return; }
      h.combat.handleProjectileDestroy(id, m);
    },
  },

  environmentDamage: {
    // One bucket serves crawler pounces, host-simmed bot damage on the
    // local player (attacker-tagged), deployables, and self-splash — a
    // firefight can legitimately burst past 10/s, and drops are silent.
    // Still self-report-only and capped per-claim (80 tagged / 40 plain).
    limit: { maxCount: 30, windowMs: 1000 },
    validate: (obj) => {
      if (!isFiniteNumber(obj.amount)) {
        return { success: false, error: 'amount must be a finite number' };
      }
      // Attribution rides through for host-simmed sources ('bot:*',
      // deployable owners). Same grammar CombatHandler re-checks —
      // validation is the gate that actually strips hostile payloads.
      const attacker = typeof obj.attacker === 'string' && /^[\w: .-]{1,32}$/.test(obj.attacker)
        ? obj.attacker : undefined;
      return { success: true, data: { type: 'environmentDamage', amount: obj.amount, attacker, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => h.claimAck(id, 'environmentDamage', m.claimSeq, h.combat.handleEnvironmentDamage(id, m)),
  },

  heal: {
    // Team rooms gate heal claims behind server-granted credit; non-team
    // claims are free-form (local nuggets have no server backing), so the
    // only bound there is rate — 3 per 2s caps invincibility-heals at
    // ~37hp/s while leaving burst pickups legal.
    limit: { maxCount: 3, windowMs: 2000 },
    validate: (obj) => {
      if (!isFiniteNumber(obj.amount)) {
        return { success: false, error: 'amount must be a finite number' };
      }
      return { success: true, data: { type: 'heal', amount: obj.amount, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    // Dedicated sims every pickup server-side — a legit heal always
    // arrives via onCollect, never a client claim. P2P hosts still
    // accept (their ambient nuggets have no server entity). Without
    // this the free-form non-team branch is a 25hp/1.5s regen window
    // any client could open — and team rooms already refuse every
    // claim ('nocredit'), so nothing legit changes there either.
    handle: (h, id, m): void => {
      if (h.acceptClaims === false) { h.claimAck(id, 'heal', m.claimSeq, 'outcomes are server-simmed'); return; }
      h.claimAck(id, 'heal', m.claimSeq, h.combat.handleHeal(id, m));
    },
  },

  creatureHit: {
    limit: { maxCount: 120, windowMs: 1000 }, // chaingun-rate hit claims vs server creatures
    validate: (obj) => {
      if (!isFiniteNumber(obj.id) || !Number.isInteger(obj.id) || obj.id < 0) {
        return { success: false, error: 'id must be a non-negative integer' };
      }
      if (!isFiniteNumber(obj.damage)) {
        return { success: false, error: 'damage must be a finite number' };
      }
      const kx = isFiniteNumber(obj.kx) ? obj.kx : undefined;
      const ky = isFiniteNumber(obj.ky) ? obj.ky : undefined;
      const kz = isFiniteNumber(obj.kz) ? obj.kz : undefined;
      return { success: true, data: { type: 'creatureHit', id: obj.id, damage: obj.damage, kx, ky, kz, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => {
      const v = h.acceptClaims === false ? null : h.ballSim?.handleHit(id, m.id, m.damage, m.kx, m.ky, m.kz);
      h.claimAck(id, 'creatureHit', m.claimSeq, v ? (v.reason ?? true) : 'gone');
    },
  },

  crawlerHit: {
    limit: { maxCount: 120, windowMs: 1000 }, // same claim rate vs ground crawlers
    validate: (obj) => {
      if (!isFiniteNumber(obj.id) || !Number.isInteger(obj.id) || obj.id < 0) {
        return { success: false, error: 'id must be a non-negative integer' };
      }
      if (!isFiniteNumber(obj.damage)) {
        return { success: false, error: 'damage must be a finite number' };
      }
      // No kx/ky/kz here — the crawler channel is melee-PvE and walkers
      // don't take impulses (SPECIES_FAMILY.damage has no impulse arg),
      // so accepting them would be dead grammar clients could forge.
      return { success: true, data: { type: 'crawlerHit', id: obj.id, damage: obj.damage, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => {
      const v = h.acceptClaims === false ? null : h.creatureSim?.handleHit(id, m.id, m.damage);
      h.claimAck(id, 'crawlerHit', m.claimSeq, v ? (v.reason ?? true) : 'gone');
    },
  },

  deploy: {
    limit: { maxCount: 4, windowMs: 1000 }, // plants are deliberate, not per-frame
    validate: (obj) => {
      const {kind} = obj;
      if (typeof kind !== 'string' || !DEPLOY_KINDS.includes(kind as DeployKind)) {
        return { success: false, error: `kind must be ${DEPLOY_KINDS.join('|')}` };
      }
      const dpos = validateVec3(obj.position);
      if (!dpos.success) {return { success: false, error: `position: ${dpos.error}` };}
      const dvel = obj.vel === undefined ? undefined : validateVec3(obj.vel);
      if (dvel !== undefined && !dvel.success) {return { success: false, error: `vel: ${dvel.error}` };}
      return { success: true, data: { type: 'deploy', kind: kind as DeployKind, position: dpos.data, vel: dvel?.data, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => h.claimAck(id, 'deploy', m.claimSeq, h.roomInfo.onDeploy?.(id, m.kind, m.position, m.vel) ?? 'gone'),
  },

  repair: {
    // Weld beam ticks per pull, same cadence as the Lightning claim lane.
    limit: { maxCount: 30, windowMs: 1000 },
    validate: (obj) => {
      if (!isFiniteNumber(obj.targetId) || !Number.isInteger(obj.targetId) || obj.targetId < 0) {
        return { success: false, error: 'targetId must be a non-negative integer' };
      }
      return { success: true, data: { type: 'repair', targetId: obj.targetId, claimSeq: optClaimSeq(obj.claimSeq) } };
    },
    handle: (h, id, m): void => h.claimAck(id, 'repair', m.claimSeq, h.acceptClaims === false ? 'outcomes are server-simmed' : (h.roomInfo.onRepair?.(id, m.targetId) ?? 'gone')),
  },

  // Mirror-only claim: the server re-derives the energy ante itself —
  // the message deliberately carries no amount or skill id.
  skillUse: {
    // Deliberate presses; the ante re-derivation keeps floods harmless
    // but each claim still echoes a claimAck, so bound the lane anyway.
    limit: { maxCount: 8, windowMs: 1000 },
    validate: (obj): { success: true; data: { type: "skillUse"; claimSeq: number | undefined; skill: string | undefined; }; } => {
      const skill = typeof obj.skill === 'string' && obj.skill.length <= 16 ? obj.skill : undefined;
      return { success: true, data: { type: 'skillUse', claimSeq: optClaimSeq(obj.claimSeq), skill } };
    },
    handle: (h, id, m): void => h.claimAck(id, 'skillUse', m.claimSeq, h.roomInfo.onSkillUse?.(id, m.skill) ?? 'gone'),
  },

  snapshotRequest: {
    // Each request reserializes + resends the whole world state — the
    // most expensive message per byte a client can send. Legit uses are
    // join-time and a rare manual resync.
    limit: { maxCount: 3, windowMs: 5000 },
    validate: (): { success: true; data: { type: "snapshotRequest"; }; } => {
      return { success: true, data: { type: 'snapshotRequest' } };
    },
    handle: (h, id): void => { h.hb('snapreq'); h.handleSnapshotRequest(id); },
  },

  // Deliberate respawn — `hold` (the L bind) parks the corpse for
  // spectating until a plain dead-state respawn releases it; the kill
  // path derives everything (kill feed, respawn timer, banked loadout).
  respawn: {
    // A held-corpse player hits respawn again to revive — L then a quick
    // click must both land. 3/s still refuses a stuck-key kill-feed flood.
    limit: { maxCount: 3, windowMs: 1000 },
    validate: (obj): { success: true; data: { type: "respawn"; hold: true | undefined; }; } => {
      return { success: true, data: { type: 'respawn', hold: obj.hold === true ? true : undefined } };
    },
    handle: (h, id, m): void => h.combat.respawnRequest(id, m.hold === true),
  },

  // Carried-flag throw: no payload — the arc derives from the shadow's
  // position/velocity/rotation truth, never a client-claimed direction.
  throwFlag: {
    limit: { maxCount: 4, windowMs: 1000 }, // spam-tossing churns flagUpdate for everyone
    validate: (): { success: true; data: { type: "throwFlag"; }; } => {
      return { success: true, data: { type: 'throwFlag' } };
    },
    handle: (h, id): void | undefined => h.roomInfo.onThrowFlag?.(id),
  },

  resync: {
    // Same cost shape as snapshotRequest (sendWorldState) plus a shadow
    // reseat — a manual desync escape hatch, not a stream.
    limit: { maxCount: 3, windowMs: 5000 },
    validate: (): { success: true; data: { type: "resync"; }; } => {
      return { success: true, data: { type: 'resync' } };
    },
    // Reseat BEFORE the replay goes out — the shadow and the echoed
    // localPlayerState must describe the same spot or the client's
    // post-snap reports/shots get judged against the stale anchor.
    handle: (h, id): void => { h.hb('resync'); h.moves.handleResyncSeat(id); h.sendWorldState(id); },
  },

  classUpdate: {
    limit: { maxCount: 10, windowMs: 1000 },
    validate: (obj) => {
      const c = obj.armorClass;
      if (c !== 'light' && c !== 'medium' && c !== 'heavy') {
        return { success: false, error: 'armorClass must be light|medium|heavy' };
      }
      return { success: true, data: { type: 'classUpdate', armorClass: c } };
    },
    // Tribes rule: the tier swap banks on the next respawn — applying
    // it mid-life would be a free heal and flip the sim's speed scale
    // without the shadow knowing.
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      // The validator allows exactly light|medium|heavy; this `in` guard
      // keeps the table honest if CLASS_STATS' keys ever drift from that.
      // Instagib rooms have no class pick - a banked swap would respawn
      // the seat into a tier the modifier doesn't allow. igun derives
      // the chassis from the rung weapon, so picks are dead there too.
      if (p && m.armorClass in CLASS_STATS && h.roomInfo.mods?.().instagib !== true && h.roomInfo.mods?.().igun !== true) {p.pendingClass = m.armorClass as ArmorClass;}
    },
  },

  perkUpdate: {
    limit: { maxCount: 10, windowMs: 1000 },
    validate: (obj) => {
      if (!isPerkId(obj.perk)) {
        return { success: false, error: 'perk must be a known PerkId' };
      }
      return { success: true, data: { type: 'perkUpdate', perk: obj.perk } };
    },
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      if (p && isPerkId(m.perk)) {p.pendingPerk = m.perk;}
    },
  },

  // Same name/map/mode grammar as the join handshake — a bad name just
  // lands you in 'default', never a rejection. No handle: GameServer
  // intercepts room hops before they reach a room's handler.
  switchRoom: {
    validate: (obj) => {
      const bots = isFiniteNumber(obj.bots)
        ? Math.max(0, Math.min(24, Math.floor(obj.bots as number)))
        : undefined;
      return { success: true, data: { type: 'switchRoom', room: word(obj.room), map: word(obj.map), mode: word(obj.mode), bots, unlisted: obj.unlisted === true ? true : undefined, noCreatures: obj.noCreatures === true ? true : undefined, noBalls: obj.noBalls === true ? true : undefined, instagib: obj.instagib === true ? true : undefined, gungame: obj.gungame === true ? true : undefined, igun: obj.igun === true ? true : undefined } };
    },
  },

  // Relay-only content: length cap is the whole validation — the server
  // never interprets the text, clients render it escaped (textContent).
  chat: {
    // Tribes 2 flood control verbatim: 4 messages per 5s trips a 10s
    // mute — canonically enough for a two-chord VGS combo, fatal to
    // machine-gun shazbotting.
    limit: { maxCount: 4, windowMs: 5000, muteMs: 10_000 },
    validate: (obj) => {
      if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > 200) {
        return { success: false, error: 'chat text must be 1-200 chars' };
      }
      // vgs carries the chord letters ("VGS") so receivers can print the
      // keypath alongside the line — newbies learn the menu by reading chat.
      const vgs = typeof obj.vgs === 'string' && /^[A-Z]{1,8}$/.test(obj.vgs) ? obj.vgs : undefined;
      return { success: true, data: { type: 'chat', text: obj.text, team: obj.team === true ? true : undefined, vgs } };
    },
    // Room-scoped relay — broadcast() only reaches this room's sockets.
    handle: (h, id, m): void => {
      const sender = h.playerManager.getPlayer(id);
      // Truncate — the relay is the broadcast ceiling too, so an
      // oversized payload would amplify one client's bandwidth into
      // every socket in the room.
      const text = typeof m.text === 'string' ? m.text.slice(0, 280) : '';
      if (!text) {return;}
      // Team channel: only the sender's own team hears it — and only
      // when the sender actually carries a team, else a ffa client
      // claiming 'team' would quietly self-filter to nobody.
      const vgs = typeof m.vgs === 'string' ? m.vgs : undefined;
      if (m.team && sender?.team) {
        for (const [pid, p] of h.playerManager.getAllPlayers()) {
          if (p.team === sender.team) {h.sendToPlayer(pid, { type: 'chat', playerId: id, text, team: true, vgs });}
        }
        return;
      }
      h.broadcast({ type: 'chat', playerId: id, text, vgs });
      // Bots can read: the relay above ships the line, this lets the
      // room turn high-confidence phrases (gg, ez, a bot's name) into
      // a squad notice — whether anyone answers is still dice+cooldown.
      h.roomInfo.emit?.({ type: 'chat', id, text, vgs });
    },
  },

  clientStats: {
    // Self-reported — no rate limit needed beyond the default bucket; the
    // client sends ~0.1Hz and forged numbers only pollute metrics, not state.
    validate: (obj) => {
      const fields: Record<string, unknown> = {};
      for (const k of ['fps', 'jsMs', 'ping', 'loss', 'jitter']) {
        if (!isFiniteNumber(obj[k])) {return { success: false, error: `clientStats.${k} must be a finite number` };}
        fields[k] = obj[k];
      }
      const renderLagMs = isFiniteNumber(obj.renderLagMs) ? (obj.renderLagMs as number) : undefined;
      let renderLag: Record<string, number> | undefined = undefined;
      if (obj.renderLag !== null && typeof obj.renderLag === 'object' && !Array.isArray(obj.renderLag)) {
        renderLag = {};
        // Per-target lag table: a room can't have >128 remotes, so a
        // bigger map is forged keys, not measurement, and only feeds
        // lookups that miss anyway.
        for (const [k, v] of Object.entries(obj.renderLag as Record<string, unknown>).slice(0, 128)) {
          if (isFiniteNumber(v) && k.length <= 64) {renderLag[k] = v;}
        }
      }
      const gap = isFiniteNumber(obj.gap) ? (obj.gap as number) : undefined;
      const starve = isFiniteNumber(obj.starve) ? (obj.starve as number) : undefined;
      const starveMs = isFiniteNumber(obj.starveMs) ? (obj.starveMs as number) : undefined;
      const drainMsMax = isFiniteNumber(obj.drainMsMax) ? (obj.drainMsMax as number) : undefined;
      return { success: true, data: { type: 'clientStats', fps: fields.fps as number, jsMs: fields.jsMs as number, ping: fields.ping as number, loss: fields.loss as number, jitter: fields.jitter as number, renderLagMs, renderLag, gap, starve, starveMs, drainMsMax } };
    },
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      if (!p) {return;}
      p.lastSeen = wallNow();
      p.clientStats = { fps: m.fps, jsMs: m.jsMs, ping: m.ping, loss: m.loss, jitter: m.jitter, renderLagMs: m.renderLagMs, renderLag: m.renderLag, gap: m.gap, starve: m.starve, starveMs: m.starveMs, drainMsMax: m.drainMsMax, at: wallNow() };
    },
  },

  ready: {
    // Stateless release — the seat's own awaitingReady flag is the gate,
    // so a forged/extra 'ready' is a no-op, not a lever.
    validate: () => ({ success: true, data: { type: 'ready' } }),
    handle: (h, id): void => { h.roomInfo.readySpawn?.(id); },
  },

  ping: {
    validate: (obj) => {
      if (!isFiniteNumber(obj.timestamp)) {
        return { success: false, error: 'ping timestamp must be a finite number' };
      }
      return { success: true, data: { type: 'ping', timestamp: obj.timestamp } };
    },
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      if (!p) {return;}
      const now = wallNow();
      p.lastSeen = now; // ping is a liveness signal too —
      // without it a non-moving client could still go "stale"
      // Clock-drift probe: a client whose whole runtime runs fast
      // (time-dilation speedhack) stamps pings at ~rate× real time —
      // declared stamp spacing vs arrival spacing diverges. 20s window
      // before a verdict; per-ping jitter averages out. Strikes count
      // on the heartbeat only — flag-for-review, never auto-kick.
      const cp = p.clockProbe ??= { s0: m.timestamp, a0: now, s: m.timestamp, a: now, strikes: 0 };
      cp.s = m.timestamp; cp.a = now;
      const span = cp.a - cp.a0;
      if (span >= 20_000) {
        const rate = (cp.s - cp.s0) / span;
        if (rate > 1.15) { cp.strikes += 1; h.hb('clockDrift'); h.hb(`clockDrift.${id}`); }
        cp.s0 = cp.s; cp.a0 = cp.a;
      }
      h.sendToPlayer(id, { type: 'pong', timestamp: m.timestamp });
    },
  },

  // Echo of the server's own ping — the measured RTT cross-checks the
  // client-reported ping riding every position frame (forgery must fool
  // both channels, and a delayed echo only shrinks what it could buy).
  pong: {
    validate: (obj) => {
      if (!isFiniteNumber(obj.timestamp)) {
        return { success: false, error: 'pong timestamp must be a finite number' };
      }
      return { success: true, data: { type: 'pong', timestamp: obj.timestamp } };
    },
    handle: (h, id, m): void => {
      const p = h.playerManager.getPlayer(id);
      if (!p) {return;}
      p.lastSeen = wallNow();
      h.roomInfo.transitNote?.(id, wallNow() - m.timestamp, m.timestamp);
    },
  },
};

export function validateMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false, error: 'Message must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const {type} = obj;
  if (typeof type !== 'string') {
    return { success: false, error: 'Message missing "type" field' };
  }
  const validator = WIRE[type as ClientMessage['type']]?.validate;
  if (!validator) {
    return { success: false, error: `Unknown message type: ${type}` };
  }
  return validator(obj) as ValidationResult<ClientMessage>;
}

/** Rate-limit bucket key for a wire type — types without their own limit
 *  share the 'default' bucket. */
export function wireLimitKey(messageType: string): string {
  return WIRE[messageType as ClientMessage['type']]?.limit ? messageType : 'default';
}

export function wireLimit(messageType: string): RateLimit {
  return WIRE[messageType as ClientMessage['type']]?.limit ?? WIRE_DEFAULT_LIMIT;
}

/** Room/map/mode name grammar — one owner so the join handshake and the
 *  room-hop path agree on what a legal name is (a drifted second copy
 *  would let one path mint rooms the other refuses). */
export const ROOM_NAME_RE = /^[\w-]{1,32}$/;
export function roomWord(v: unknown): string | undefined {
  return typeof v === 'string' && ROOM_NAME_RE.test(v) ? v : undefined;
}
