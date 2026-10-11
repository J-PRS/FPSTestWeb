// spotBoard — the squad's shared eyes. Per enemy: the last team that had
// real sight on it, where, and when. A Tribes sightline is ~300m, not the
// 45m duel band: a bot reports whatever its target scan LOS-verified for
// the whole squad, and the report decays in a few seconds.

import { STATUS } from '../../shared/status.ts';
import type { BotEnemy } from '../../shared/botBrain.ts';
import type { PlayerManager } from './PlayerManager.ts';

export class SpotBoard {
  private spots = new Map<string, { e: BotEnemy; team?: string; at: number }>();
  private static readonly SPOT_MS = 5000;

  constructor(private players: PlayerManager) {}

  /** Feed one bot's verified sightings — the scanVisible passers it
   *  collected this scan cycle (reusing the hunt's own LOS work; a
   *  second march per enemy per think was the build stage's whole cost).
   *  Cloaking burns your callout: the shimmer's whole point is every eye
   *  losing you at once, so a stale spot can't keep feeding lastSeen to
   *  a squad that sees nothing. */
  update(p: { team?: string }, seen: BotEnemy[], now: number): void {
    for (const [id, s] of this.spots) {
      const q = this.players.getPlayer(s.e.id.replace(/^p:/, ''));
      if (q?.status && (q.status & STATUS.CLOAK)) {this.spots.delete(id);}
    }
    for (const e of seen) {
      if (e.id.startsWith('b:') || e.id.startsWith('c:')) {continue;}
      this.spots.set(e.id, { e, team: p.team, at: now });
    }
  }

  /** Reports for this team, fresh enough to still mean something. */
  forTeam(me: string | undefined, now: number): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, s] of this.spots) {
      if (now - s.at > SpotBoard.SPOT_MS) { this.spots.delete(id); continue; }
      if (s.team === me && s.e.alive) {out.push(s.e);}
    }
    return out;
  }
}
