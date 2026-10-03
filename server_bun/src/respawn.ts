/**
 * RespawnManager — the death→spawn lifecycle: one pending timer per
 * player, cancelled on teardown/disconnect, re-armed on rejoin. Split
 * from CombatHandler so the damage funnel stops owning timer hygiene.
 */
import { CONFIG } from './config.ts';
import { simNow } from './simClock.ts';
import { logger } from './logger.ts';
import type { ServerMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { wallNow } from './wallClock.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;

export class RespawnManager {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Sim-time deadline per pending respawn — the fast-forward driver
   *  ticks these down since wall-clock setTimeout can't keep pace when
   *  sim-time outruns real time. In live mode the wall timer still fires
   *  first; tick is a no-op shadow then. */
  private dueAt: Map<string, number> = new Map();

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
    const pending = this.timers.get(playerId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(playerId);
      this.dueAt.delete(playerId);
    }
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
      player.correctionGraceUntil = wallNow() + CONFIG.reportGraceMs;

      this.broadcast({
        type: 'playerRespawn',
        playerId,
        internalId: player.internalId,
        position: result.position,
        rotation: result.rotation,
        // A banked classUpdate may have just applied — remotes rebuild
        // the silhouette off this rather than learning it on next join.
        armorClass: result.armorClass,
      });
    }, CONFIG.respawnDelayMs);
    this.timers.set(playerId, timer);
  }

  /** Sim-paced respawn pass for un-networked drivers: fires any pending
   *  respawn whose sim-deadline passed. Live rooms never call this — the
   *  wall timer does the firing — so wire behavior is unchanged. */
  tick(now: number): void {
    for (const [id, at] of this.dueAt) {
      if (now < at) continue;
      this.timers.delete(id);
      this.dueAt.delete(id);
      this.playerManager.respawnPlayer(id);
      const player = this.playerManager.getPlayer(id);
      if (player) {
        player.correctionGraceUntil = simNow() + CONFIG.reportGraceMs;
        this.broadcast({
          type: 'playerRespawn',
          playerId: id,
          internalId: player.internalId,
          position: player.position,
          rotation: player.rotation,
          armorClass: player.armorClass,
        });
      }
    }
  }

  /** Room teardown — pending respawns die with the room or they fire
   *  broadcasts into an empty world. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.dueAt.clear();
  }
}
