import type { ClientMessage, ServerMessage, Vec3, PlayerState } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import { pushRewindSample } from './rewind.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { inv } from '../../shared/invariants.ts';

// Movement-claim family — position reports, declared teleports, and the
// plausibility judge that guards them. Split from MessageHandler so the
// dispatch surface stays a routing table; all room/sim hooks arrive
// through the host surface below.

export interface MoveHost {
  playerManager: PlayerManager;
  sendToPlayer(playerId: string, msg: ServerMessage): void;
  broadcast(msg: ServerMessage, excludePlayerId?: string): void;
  hb(key: string, n?: number): void;
  hbMax(key: string, v: number): void;
  /** Room-side announce gate — first position report broadcasts join. */
  announceIfInWorld(player: PlayerState): void;
  moveAuthority(): boolean;
  /** Held input riding the volatile position stream — a superseding
   *  datagram-style input path next to the change-only inputMove
   *  edges: seq-ungated (monotonicity is enforced by the position
   *  seq gate at the call site), so a lost frame costs nothing. */
  moveInput?(playerId: string, input: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number, ageMs?: number): boolean | void;
  /** Highest inputMove edge seq consumed so far — held-state frames
   *  older than it must not resurrect a released key. */
  inputSeqOf?(playerId: string): number;
  moveReport(playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number, rttMs?: number):
    { pos: Vec3; vel: Vec3; inputSeq: number; onGround: boolean } | null;
  moveResync(playerId: string, pos: Vec3, yaw: number): void;
  moveMute(playerId: string): void;
}

export class MoveClaims {
  /** Declared-warp cadence — TL beacons are ≥4s apart (TL_COOLDOWN),
   *  joins/respawns are one-offs, so 3s leaves every legal warp free
   *  while a teleport-spam client eats plausibility corrections instead
   *  of free relocation. */
  private lastTeleport = new Map<string, number>();
  /** Throttles the offender-facing warn — a spamming client would otherwise
   *  receive a serverWarn per claim, the same log-IO flood shape the
   *  invalid-message throttle covers. */
  private lastTeleportWarn = new Map<string, number>();

  constructor(private h: MoveHost) {}

  dropPlayer(playerId: string): void {
    this.lastTeleport.delete(playerId);
    this.lastTeleportWarn.delete(playerId);
  }

  handlePosition(playerId: string, msg: Extract<ClientMessage, { type: 'position' }>): void {
    const player = this.h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {return;}

    const now = wallNow();
    // Liveness stamps on ANY well-formed report — a seq-regressed or
    // plausibility-rejected client is still connected; gating lastSeen
    // inside the judge gates idle-reaps an actively-talking player.
    player.lastSeen = now;
    player.lastClaimAt = now;
    if (!this.plausible(playerId, player, msg, now)) {return;}

    // Held input rides the volatile frame — the superseding-stream
    // input path. Two gates: the position seq must be the newest seen
    // (an unordered older frame must not resurrect a released key),
    // and the frame's inputSeq must cover the newest edge already
    // consumed (a frame encoded BEFORE an edge left the client can
    // otherwise rewind the input that edge just set). Keep the player's
    // status channel: held frames carry no status bits.
    if (msg.input !== undefined && msg.seq !== undefined && msg.seq > player.lastSeq
        && (msg.inputSeq === undefined || msg.inputSeq >= (this.h.inputSeqOf?.(playerId) ?? -1))) {
      this.h.moveInput?.(playerId, msg.input, player.status & CLIENT_STATUS_MASK);
      player.skiing = msg.input.ski ? 1 : 0;
      player.jetting = msg.input.jet ? 1 : 0;
    }

    // inputSeq (not the frame seq) anchors the probe: it's the count of
    // inputMove events the client had consumed when it took this snapshot.
    // msg.ping is the client's own RTT measure riding this frame — the
    // judge credits it as link-transit staleness (see moveJudge).
    const simTruth = this.h.moveReport(playerId, msg.position, msg.rotation.yaw, msg.velocity, msg.inputSeq, msg.ping);

    if (this.h.moveAuthority()) {
      // Authority mode: the sim owns position — the report only feeds it
      // yaw/vel hints and carries ping + liveness. Corrections still flow
      // on divergence (tighter tolerance/throttle inside the sim).
      if (simTruth) {
        this.h.sendToPlayer(playerId, {
          type: 'correction',
          seq: msg.seq ?? 0,
          inputSeq: simTruth.inputSeq,
          grounded: simTruth.onGround,
          position: simTruth.pos,
          velocity: simTruth.vel,
          rotation: msg.rotation,
        });
        // Reseat the plausibility anchor at the corrected position: the
        // client's next report legitimately snaps to simTruth.pos, and
        // without this the snap itself reads as a speedhack reject.
        player.lastPosCheckPos = Object.assign({}, simTruth.pos);
        this.muteJudges(player, playerId, now);
      }
      player.rotation.yaw = msg.rotation.yaw; player.rotation.pitch = msg.rotation.pitch;
      player.lastSeen = now;
      if (msg.seq !== undefined && msg.seq > player.lastSeq) {player.lastSeq = msg.seq;}
      player.hasReceivedPosition = true;
      this.h.announceIfInWorld(player);
      if (msg.ping !== undefined) {player.ping = Math.min(Math.max(1, msg.ping), 2000);}
      pushRewindSample(player, now); // player.position is sim truth
      return;
    }

    // Judge mode: divergence is an anti-cheat SIGNAL, never a correction.
    // The shadow sim replays snapshot inputs at fixed ticks while the
    // client integrates per-frame — honest play drifts past tolerance
    // routinely, and snapping the client on sim drift IS the warp
    // players feel. reconcile() still counts divergences for kicks;
    // the client's own report stays truth (as updatePosition applies).
    this.h.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity, msg.seq);
    player.hasReceivedPosition = true;
    this.h.announceIfInWorld(player);
    if (msg.ping !== undefined) {player.ping = Math.min(Math.max(1, msg.ping), 2000);}
    pushRewindSample(player, now);
    // Don't broadcast immediately — batched in tickUpdate
  }

  /** Cheat prevention: position plausibility. Compares CONSECUTIVE reports
   *  (lastPosCheck* updates even on reject), so a rejected position
   *  doesn't poison every subsequent check — the old version measured
   *  each new report against a stale accepted pos, spiralling into
   *  permanent rejection once a player got >threshold away.
   *  Returns false when the report is rejected (still counting up the
   *  force-accept streak); true accepts, including the >10 force-accept
   *  resync for a client persisting past corrections. */
  private plausible(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'position' }>, now: number): boolean {
    // NaN math fails every comparison below — which would LOOK like a
    // reject, except the first report seeds the anchor unconditionally
    // (line ~140) and authority mode feeds the sim after this returns
    // true. One non-finite claim would poison both.
    if (!Number.isFinite(msg.position.x + msg.position.y + msg.position.z
        + (msg.velocity?.x ?? 0) + (msg.velocity?.y ?? 0) + (msg.velocity?.z ?? 0)
        + msg.rotation.yaw + msg.rotation.pitch)) {return false;}
    const dt = Math.max((now - player.lastPosCheckTime) / 1000, 0.05); // floor: bursts of queued packets report ~1ms gaps
    player.lastPosCheckTime = wallMs(now);
    if (!player.hasReceivedPosition || !player.lastPosCheckPos) {
      player.lastPosCheckPos = Object.assign({}, msg.position);
      return true;
    }
    // Field-wise anchor update — plausible() runs per position report
    // (~20Hz/player), a spread per call is steady GC churn on the
    // hottest ingest path (same class as §2.63).
    const dx = msg.position.x - player.lastPosCheckPos.x;
    const dy = msg.position.y - player.lastPosCheckPos.y;
    const dz = msg.position.z - player.lastPosCheckPos.z;
    const dist = (dx * dx + dy * dy + dz * dz) ** 0.5;
    const speed = dist / dt;
    player.lastPosCheckPos.x = msg.position.x;
    player.lastPosCheckPos.y = msg.position.y;
    player.lastPosCheckPos.z = msg.position.z;
    // Reject only genuine impossibilities: >50m in one report, or speed
    // beyond any legit combination of skiing + knockback + jetpack.
    // The window has to be a REAL window — position reports stream at
    // 20Hz, so dt > ~0.5s means the report chain broke (transport blip,
    // hidden tab, transport switch), and the accumulated distance over
    // a dead interval isn't speed evidence (34s gap → 589m at 17m/s
    // used to reject). Reseat the anchor and resume measuring.
    // A correction we just sent snaps the client's reports onto sim
    // truth — but reports emitted before the packet landed still come
    // from the old trajectory and would all read as impossible speed.
    // Mute the check while those in-flight reports drain (grace covers
    // ~2 RTTs of stragglers).
    if (now < player.correctionGraceUntil || dt > 0.5 || (dist <= 50 && speed <= 300)) {
      player.consecutiveRejects = 0;
      return true;
    }
player.consecutiveRejects += 1;
    this.h.hb('posrej');
    this.h.hbMax('posrejSpeed', speed);
    // Send correction on the first reject of a streak only — no flood.
    // The warn follows the same rule: every report in a reject streak is
    // the same divergence (unique text also defeats logger burst-collapse),
    // so per-reject logging is ~20 warns/s of pure noise per offender.
    if (player.consecutiveRejects === 1) {
      logger.warn(`Position rejected: ${playerId} moved ${dist.toFixed(1)}m in ${dt.toFixed(3)}s (${speed.toFixed(0)} m/s)`);
      const validState = this.h.playerManager.getLastValidState(playerId);
      if (validState) {
        this.h.sendToPlayer(playerId, {
          type: 'correction',
          seq: validState.seq,
          position: validState.position,
          velocity: validState.velocity,
          rotation: validState.rotation,
        });
        // COMMIT the anchor: reseat the check point AT the corrected
        // position. We just told the client to teleport there — its
        // post-snap report legitimately sits ~far from the rejected
        // pos we recorded above, and without this reseat it is
        // guaranteed-rejected, accumulates to the >10 force-accept,
        // flips lastValid to the far anchor, and the next correction
        // snaps the client BACK — the infinite ping-pong. One anchor,
        // one commit: either the client lands at the correction
        // (accepts immediately) or keeps fighting (rejects count up
        // to the force-accept, which then sticks).
        player.lastPosCheckPos = Object.assign({}, validState.position);
        this.muteJudges(player, playerId, now);
      }
    }
    // Client persisting past corrections (disputed knockback, lost
    // correction packet): force-accept after 10 rejects to resync
    // instead of warping the player forever.
    if (player.consecutiveRejects <= 10) {return false;}
    this.h.hb('posforce');
    logger.warn(`Position force-accepted: ${playerId} after ${player.consecutiveRejects} rejects (resync)`);
    player.consecutiveRejects = 0;
    return true;
  }

  // Declared discontinuity (warp beacon, respawn): position arrives
  // pre-accepted — reseat the plausibility anchor so the NEXT report
  // deltas from here instead of measuring a 50m jump as a speedhack.
  handleTeleport(playerId: string, msg: Extract<ClientMessage, { type: 'teleport' }>): void {
    const player = this.h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {return;}
    // lastValid* below are written directly, bypassing updatePosition's
    // finite gate — a non-finite warp claim must die here, not after.
    if (!Number.isFinite(msg.position.x + msg.position.y + msg.position.z
        + msg.velocity.x + msg.velocity.y + msg.velocity.z
        + msg.rotation.yaw + msg.rotation.pitch)) {return;}
    const now = wallNow();
    // Honor EVERY declared warp: the client already moved, so refusing
    // the reseat just recreates the warp as impossibly-fast pos reports
    // (the force-accept loop) and starves observers of the relay — the
    // drop never stopped the warp anyway. Abuse is a violation count
    // toward the same kick wiring the diverge counter feeds.
    if ((this.lastTeleport.get(playerId) ?? 0) > now) {
      this.h.hb('teleportSpam');
      logger.warn('teleport spam: inside cadence window — honored, counted', { playerId });
      if ((this.lastTeleportWarn.get(playerId) ?? 0) <= now) {
        this.lastTeleportWarn.set(playerId, now + 5000);
        this.h.sendToPlayer(playerId, { type: 'serverWarn', text: 'teleport spam detected' });
      }
    }
    this.lastTeleport.set(playerId, now + 3000);
    // Authority mode: the shadow owns position, so a declared warp only
    // reseats where the server can explain it. Near the recorded
    // position covers resync/reconnect/respawn snaps (respawnPlayer
    // already wrote the record at the spawn). The beacon's landing is
    // client-owned, but an accepted skillUse inside the window is
    // evidence a legal warp exists. Anything else is a forged reseat:
    // honoring put the authoritative shadow wherever the claim pointed.
    // Judge mode keeps the honor-everything contract: position is
    // already client-truth there, and the force-accept resync would
    // land it anyway.
    if (this.h.moveAuthority()) {
      const drift = Math.hypot(
        msg.position.x - player.position.x,
        msg.position.y - player.position.y,
        msg.position.z - player.position.z);
      const skilled = player.lastSkillUse !== undefined && now - player.lastSkillUse < 4000;
      if (drift > 25 && !skilled) {
        this.h.hb('teleportForged');
        if ((this.lastTeleportWarn.get(playerId) ?? 0) <= now) {
          this.lastTeleportWarn.set(playerId, now + 5000);
          this.h.sendToPlayer(playerId, { type: 'serverWarn', text: 'teleport refused' });
        }
        return;
      }
    }
    // A declared warp landing under the floor is the same buried-body
    // seed a bad spawn is — counted, never refused (the client already
    // moved; refusing recreates the warp as impossibly-fast reports).
    const tg = this.h.playerManager.groundAt?.(msg.position.x, msg.position.z);
    inv('teleport-above-ground', tg === undefined || !Number.isFinite(tg) || msg.position.y >= tg - 0.5,
      { id: playerId, y: Number(msg.position.y.toFixed(1)), ground: tg !== undefined && Number.isFinite(tg) ? Number(tg.toFixed(1)) : 'n/a' });
    player.lastPosCheckPos = Object.assign({}, msg.position);
    player.lastPosCheckTime = wallNow();
    player.consecutiveRejects = 0;
    this.h.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity, undefined);
    // updatePosition only touches lastValid on a seq bump — a declared
    // teleport has no seq, so seat it manually or the next correction
    // would snap the player back to BEFORE the warp
    player.lastValidPosition = Object.assign({}, msg.position);
    player.lastValidVelocity = Object.assign({}, msg.velocity);
    player.lastValidRotation = Object.assign({}, msg.rotation);
    player.hasReceivedPosition = true;
    this.h.announceIfInWorld(player);
    this.h.moveResync(playerId, msg.position, msg.rotation.yaw);
    // Reports already in flight predate the warp — same drain window
    // corrections and respawns get.
    this.muteJudges(player, playerId, now);
    // Pre-warp samples are a different location entirely — keeping them
    // lets lag-comp rewind land the shooter/target back at the corpse.
    player.history.length = 0;
    pushRewindSample(player, now);
    // Relay so observers snap instead of interpolating across the gap
    this.h.broadcast(eventPayload(WORLD_MODEL.player!, 'teleport', 'playerId', playerId, { position: msg.position, velocity: msg.velocity }) as ServerMessage, playerId);
  }

  /** Resync claim (alt-tab catch-up): the client is about to snap onto
   *  our stored truth, which makes that truth a declared discontinuity —
   *  same seat discipline as a teleport. Without this the pre-stall
   *  anchor and the hidden interval's stale reports fight the fresh
   *  ones: the shadow stays frozen, StateHash reads a permanent desync,
   *  and every shot claim spawns "implausible" until reconnect.
   *  No teleport broadcast — the stored pos hasn't moved, so remote
   *  clients already interpolate to it. */
  handleResyncSeat(playerId: string): void {
    const player = this.h.playerManager.getPlayer(playerId);
    if (!player || !player.hasReceivedPosition) {return;}
    const now = wallNow();
    player.lastPosCheckPos = Object.assign({}, player.position);
    player.lastPosCheckTime = now;
    player.consecutiveRejects = 0;
    this.h.moveResync(playerId, player.position, player.rotation.yaw);
    this.muteJudges(player, playerId, now);
    // Pre-stall rewind samples are a different timeline — same poison as
    // the pre-warp history a teleport clears.
    player.history.length = 0;
    pushRewindSample(player, now);
  }

  /** Every re-seat (correction out, respawn, room hop, teleport) must
   *  mute BOTH judges for the drain window: plausibility via the grace
   *  timestamp, the shadow sim via moveMute/markReseated — in-flight
   *  pre-warp reports otherwise read as speedhacks on one judge or
   *  divergences on the other. */
  private muteJudges(player: PlayerState, playerId: string, now: number): void {
    player.correctionGraceUntil = wallMs(now + CONFIG.reportGraceMs);
    this.h.moveMute(playerId);
  }
}
