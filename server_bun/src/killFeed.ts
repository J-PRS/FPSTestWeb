/**
 * KillFeed — the kill-cam voice of the room: match notices (first blood,
 * spree tiers, streak endings) plus bot taunts delivered over the real
 * chat wire. Split from CombatHandler so the damage funnel stays about
 * damage policy; this file only knows roster lookups + broadcast.
 */
import type { ServerMessage } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { killTaunt, deathTaunt, envDeathTaunt, spreeTaunt } from '../../shared/botTaunts.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;

const SPREE_TIERS: [number, string][] = [
  [3, 'killing spree'], [5, 'rampage'], [8, 'dominating'], [12, 'unstoppable'],
];

export class KillFeed {
  /** Typing-beat delay supplier — tests stub CombatHandler.tauntDelayMs
   *  (injected here) so sim-time-only runs see taunts inside the frag
   *  loop. */
  private pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private playerManager: PlayerManager,
    private broadcast: BroadcastFn,
    private tauntDelayMs: () => number,
  ) {}

  announce(shooterId: string, targetId: string): void {
    const victim = this.playerManager.getPlayer(targetId);
    const ended = victim?.streak ?? 0;
    if (victim) victim.streak = 0;
    if (targetId.startsWith('BOT-')) {
      this.botSay(targetId, shooterId === 'environment'
        ? envDeathTaunt(targetId)
        : deathTaunt(targetId, shooterId));
    }
    if (shooterId === 'environment') return;
    // Self-splash reads as a death, not a frag — no streak credit, no
    // taunt, just the suicide notice.
    if (shooterId === targetId) {
      this.broadcast({ type: 'matchNotice', text: `${targetId} fragged themselves` });
      return;
    }

    const shooter = this.playerManager.getPlayer(shooterId);
    if (!shooter) return;
    shooter.streak++;

    if (this.playerManager.killTotal() === 1) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} draws first blood` });
    }
    const tier = SPREE_TIERS.find(([n]) => n === shooter.streak);
    if (tier) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is on a ${tier[1]} (${tier[0]})` });
      if (shooterId.startsWith('BOT-')) this.botSay(shooterId, spreeTaunt(shooterId));
    } else if (shooter.streak > 12 && shooter.streak % 4 === 0) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is godlike (${shooter.streak})` });
    }
    if (ended >= 3) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} ended ${targetId}'s ${ended}-kill streak` });
    }

    // Bots mouth off on the real chat wire — same 'chat' shape players
    // send, so it lands in the feed indistinguishable from a human line.
    if (shooterId.startsWith('BOT-')) {
      this.botSay(shooterId, killTaunt(shooterId, targetId));
    }
  }

  /** A bot's chat line lands like a typed reply — a beat after the
   *  event, not inside the kill frame, and dropped if the speaker left
   *  the room meanwhile. Timers are tracked so room teardown can drain. */
  private botSay(id: string, line: string | null): void {
    if (!line) return;
    const delay = this.tauntDelayMs();
    const speak = () => {
      if (this.playerManager.getPlayer(id)) this.broadcast({ type: 'chat', playerId: id, text: line });
    };
    if (delay <= 0) { speak(); return; }
    const t = setTimeout(() => { this.pending.delete(t); speak(); }, delay);
    this.pending.add(t);
  }

  /** Room teardown — drain queued taunts so a dead room can't speak. */
  dispose(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}
