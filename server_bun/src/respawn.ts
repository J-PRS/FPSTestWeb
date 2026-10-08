/**
 * RespawnManager — the death→spawn lifecycle: one pending timer per
 * player, cancelled on teardown/disconnect, re-armed on rejoin. Split
 * from CombatHandler so the damage funnel stops owning timer hygiene.
 */
import { CONFIG } from './config.ts';
import { simNow } from './simClock.ts';
import { logger } from './logger.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { wallNow , wallMs} from './wallClock.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;

export class RespawnManager {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Sim-time deadline per pending respawn — the fast-forward driver
   *  ticks these down since wall-clock setTimeout can't keep pace when
   *  sim-time outruns real time. In live mode the wall timer still fires
   *  first; tick is a no-op shadow then. */
  private dueAt: Map<string, number> = new Map();
  /** Die-and-spectate holds — the respawn claim's `hold` flag parks the
   *  corpse: the timer fires and leaves the player dead until a plain
   *  dead-state respawn releases it. */
  private held = new Set<string>();

  constructor(
    private playerManager: PlayerManager,
    private broadcast: BroadcastFn,
    /** Seat the move-sim shadow at the spawn — the corpse→spawn jump
     *  reads as divergence without it. */
    private moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void,
  ) {}

  /** Cancel a pending respawn on disconnect/removal — a stale timer
   *  would fire on a rejoining player's new session (or double-respawn
   *  if they died again after reconnecting). */
  cancel(playerId: string): void {
    this.held.delete(playerId); // a disconnect/removal ends any hold — a rejoin re-arms fresh
    const pending = this.timers.get(playerId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(playerId);
      this.dueAt.delete(playerId);
    }
  }

  /** L-bind respawn hold: mark BEFORE the kill so the timer the death
   *  schedules inherits it. */
  hold(playerId: string): void { this.held.add(playerId); }
  isHeld(playerId: string): boolean { return this.held.has(playerId); }

  /** Dead-state respawn press — releases a die-and-spectate hold. A
   *  pending unheld timer is NOT skippable: clicking through the
   *  countdown would make respawnDelay decorative, so the press waits
   *  for the fire like everyone else. */
  respawnNow(playerId: string): void {
    this.held.delete(playerId);
    const pending = this.timers.get(playerId);
    if (pending) return; // countdown still owed — the timer fires
    this.dueAt.delete(playerId);
    this.fire(playerId, wallNow());
  }

  /** The shared revive tail — timer, sim-tick, and respawnNow all land
   *  here so grace + broadcast can't drift between paths. `graceClock`
   *  is the caller's domain (sim-time drivers arm sim-time grace). */
  private fire(playerId: string, graceClock: number): void {
    const result = this.playerManager.respawnPlayer(playerId);
    if (!result) return;
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;
    logger.info('Player respawned', { playerId, position: result.position });
    this.moveResync?.(playerId, result.position, result.rotation.yaw, true);
    // The respawn broadcast and the honest post-snap report are both
    // in flight — the client's snap to spawn (and any straggler
    // reports from the corpse spot) read as impossible speed/
    // divergence against the reseated anchors. Same drain window a
    // correction gets.
    player.correctionGraceUntil = wallMs(graceClock + CONFIG.reportGraceMs);
    // A banked classUpdate may have just applied — remotes rebuild
    // the silhouette off armorClass rather than learning it on next join.
    this.broadcast(eventPayload(WORLD_MODEL.player!, 'playerRespawn', 'playerId', playerId, {
      internalId: player.internalId,
      position: result.position,
      rotation: result.rotation,
      armorClass: result.armorClass,
    }) as ServerMessage);
  }

  /** Reconnect restores state verbatim — including isDead. If the
   *  disconnect cancelled a pending respawn (it did), a restored-dead
   *  player would stay dead forever without this re-arm. */
  ensure(playerId: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (player?.isDead && !this.timers.has(playerId)) {
      this.schedule(playerId);
    }
  }

  /** Re-arm respawn for a rejoining dead player — same gap as ensure,
   *  but replaces an existing timer (socket flap mid-death). */
  ensureScheduled(playerId: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (player?.isDead) this.schedule(playerId);
  }

  schedule(playerId: string): void {
    // One respawn timer per player — a second kill while dead replaces
    // it instead of stacking.
    const existing = this.timers.get(playerId);
    if (existing) clearTimeout(existing);
    this.dueAt.set(playerId, simNow() + CONFIG.respawnDelayMs);
    const timer = setTimeout(() => {
      this.timers.delete(playerId);
      this.dueAt.delete(playerId);
      // Held corpse (die-and-spectate) — the deadline lapses silently;
      // a dead-state respawn claim is what revives them.
      if (this.held.has(playerId)) return;
      try {
      this.fire(playerId, wallNow());
      } catch (e) {
        // A throw here stranded the player dead forever — the process
        // handler would survive it but nobody would ever re-fire the
        // respawn. Log with the victim so a stuck-dead report names him.
        logger.error('Respawn timer failed', { playerId, err: e instanceof Error ? e.message : String(e) });
      }
    }, CONFIG.respawnDelayMs);
    this.timers.set(playerId, timer);
  }

  /** Sim-paced respawn pass for un-networked drivers: fires any pending
   *  respawn whose sim-deadline passed. Live rooms never call this — the
   *  wall timer does the firing — so wire behavior is unchanged. */
  tick(now: number): void {
    for (const [id, at] of this.dueAt) {
      if (now < at) continue;
      // The wall timer is still armed — deleting the bookkeeping alone
      // leaves it to fire() a second time on its own schedule. Sim-paced
      // drivers reach deadlines ahead of wall clock, so every respawn
      // would broadcast twice.
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
      this.dueAt.delete(id);
      if (this.held.has(id)) continue; // held corpse — same gate as the wall timer
      this.fire(id, now);
    }
  }

  /** Room teardown — pending respawns die with the room or they fire
   *  broadcasts into an empty world. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.dueAt.clear();
    this.held.clear();
  }
}
