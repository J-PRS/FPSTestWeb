import { SheepMeter, type SheepBody } from './botSheep.js';
import type { Player } from '../entities/Player.js';
import type { Terrain } from '../world/terrain.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { RemotePlayerState } from '../networking/NetworkManager.js';
import type { RemoteSet } from './net/RemoteSet.js';
import type { TeamId } from '../../../shared/teams.js';

/**
 * The same meter that reads bots, run on the local player — feeds the
 * under-crosshair readout and the scoreboard self-row. Rates mirror the
 * wire humans' server meter, so tuning you feel is what bots get.
 */
export class PlayerSheep {
  private meter = new SheepMeter({ warn: (m) => console.warn(`[sheep] ${m}`) });
  private body: SheepBody;
  private prevShoot = 0;

  constructor(private playerIdOf: () => string) {
    this.body = { playerId: this.playerIdOf(), pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, sheep: 0, sheepShown: 0 };
  }

  /** Frame tick — the body's pos/vel alias the live Player vectors, so
   *  nothing here samples stale state. Fire recency comes off the
   *  shoot-anim rising edge (covers every weapon incl. melee/burst). */
  tick(dt: number, player: Player, terrain: Terrain | null, remotes: RemoteSet<RemotePlayer, RemotePlayerState>, localTeam: TeamId | undefined): void {
    if (!terrain) return;
    this.meter.advance(dt);
    this.body.playerId = this.playerIdOf();
    this.body.pos = player.pos;
    this.body.vel = player.vel;
    if (player.isDead) { this.meter.clear(this.body.playerId); this.body.sheep = this.body.sheepShown = 0; return; }
    if (this.prevShoot <= 0 && player.shootAnimTimer > 0) this.meter.markShot(this.body.playerId);
    this.prevShoot = player.shootAnimTimer;
    const foe = this.foeNear(player, remotes, localTeam);
    this.meter.tick(this.body, dt, terrain, {
      foe,
      ignoring: foe && this.meter.notShooting(this.body.playerId),
      // A live player always intends somewhere — the coverage stall is
      // the ground truth a parked player is measured by, same as the
      // server's wire-human metering.
      hasDest: true,
    });
  }

  get shown(): number { return Math.round(this.body.sheepShown); }

  /** 45m enemy brawl range — same evidence the meter gives bots and
   *  wire humans; LOS stays out of it since a human owns the sneak. */
  private foeNear(player: Player, remotes: RemoteSet<RemotePlayer, RemotePlayerState>, localTeam: TeamId | undefined): boolean {
    for (const [, rp] of remotes) {
      if (rp.isDead) continue;
      const team = (rp as { team?: string }).team;
      if (localTeam && team === localTeam) continue;
      const p = rp.position;
      const d = (p.x - player.pos.x) ** 2 + (p.y - player.pos.y) ** 2 + (p.z - player.pos.z) ** 2;
      if (d < 45 * 45) return true;
    }
    return false;
  }
}
