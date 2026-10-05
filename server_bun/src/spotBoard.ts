// spotBoard — the squad's shared eyes. Per enemy: the last team that had
// real sight on it, where, and when. A Tribes sightline is ~300m, not the
// 45m duel band: inside SPOT_M a bot reports what it sees for the whole
// squad, and the report decays in a few seconds.

import { STATUS } from '../../shared/status.ts';
import { dist3 } from '../../shared/botVec.ts';
import { losClear, type BotEnemy, type BrainCtx } from '../../shared/botBrain.ts';
import type { Vec3 } from '../../shared/types.ts';
import type { PlayerManager } from './PlayerManager.ts';

export class SpotBoard {
  private spots = new Map<string, { e: BotEnemy; team?: string; at: number }>();
  private static readonly SPOT_M = 320;
  private static readonly SPOT_MS = 5000;

  constructor(private players: PlayerManager) {}

  /** Feed one bot's senses — every enemy it can actually see joins the
   *  board for its team. Cloaking burns your callout: the shimmer's whole
   *  point is every eye losing you at once, so a stale spot can't keep
   *  feeding lastSeen to a squad that sees nothing. */
  update(ctx: BrainCtx, p: { team?: string; position: Vec3 }): void {
    for (const [id, s] of this.spots) {
      const q = this.players.getPlayer(s.e.id.replace(/^p:/, ''));
      if (q?.status && (q.status & STATUS.CLOAK)) this.spots.delete(id);
    }
    for (const e of ctx.enemies) {
      if (!e.alive || e.id.startsWith('b:') || e.id.startsWith('c:') || dist3(p.position, e.pos) >= SpotBoard.SPOT_M) continue;
      if (!losClear(ctx, p.position, e.pos)) continue;
      this.spots.set(e.id, { e, team: p.team, at: ctx.now });
    }
  }

  /** Reports for this team, fresh enough to still mean something. */
  forTeam(me: string | undefined, now: number): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, s] of this.spots) {
      if (now - s.at > SpotBoard.SPOT_MS) { this.spots.delete(id); continue; }
      if (s.team === me && s.e.alive) out.push(s.e);
    }
    return out;
  }
}
