/**
 * KillFeed — the kill-cam voice of the room: match notices (first blood,
 * spree tiers, streak endings) plus bot taunts delivered over the real
 * chat wire. Split from CombatHandler so the damage funnel stays about
 * damage policy; this file only knows roster lookups + broadcast.
 */
import type { ServerMessage } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { killTaunt, deathTaunt, envDeathTaunt, spreeTaunt, chatter, type ChatterKind, type TauntLine } from '../../shared/botTaunts.ts';
import { tauntRand } from '../../shared/botRand.ts';
import { logger } from './logger.ts';
import { WeaponType } from '../../shared/weapons.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

const SPREE_TIERS: [number, string][] = [
  [3, 'killing spree'], [5, 'rampage'], [8, 'dominating'], [12, 'unstoppable'],
];

export class KillFeed {
  /** Typing-beat delay supplier — tests stub CombatHandler.tauntDelayMs
   *  (injected here) so sim-time-only runs see taunts inside the frag
   *  loop. */
  private pending = new Set<ReturnType<typeof setTimeout>>();
  /** victimId → killerId — a kill on someone who just fragged YOU is
   *  the revenge line's trigger; cleared implicitly as targets die to
   *  others (each frag overwrites the victim's slot). */
  private lastKiller = new Map<string, string>();
  /** Consecutive deaths per bot — three unanswered deaths is the tilt
   *  threshold; cleared when the bot lands a kill of their own. */
  private deathStreak = new Map<string, number>();

  constructor(
    private playerManager: PlayerManager,
    private broadcast: BroadcastFn,
    private tauntDelayMs: () => number,
    /** A bot's line actually landed on the wire — hosts use it to offer
     *  the room a 'reply' notice, so a bark can become a two-bot beat
     *  without any dialogue scripting. */
    private onBotSpoke?: (id: string) => void,
    /** Team-scoped delivery for tactical VGS chords — canon: only
     *  squadmates hear "Defend our flag!". */
    private sendToPlayer?: SendToPlayerFn,
  ) {}

  /** Player fully removed — drop their streak/grudge entries. Both maps
   *  are keyed by live player ids; a churned roster would otherwise bank
   *  one entry per player who ever passed through the room. */
  forget(playerId: string): void {
    this.lastKiller.delete(playerId);
    this.deathStreak.delete(playerId);
    for (const [victim, killer] of this.lastKiller) {
      if (killer === playerId) this.lastKiller.delete(victim);
    }
  }

  announce(shooterId: string, targetId: string, weapon?: number, label?: string): void {
    const victim = this.playerManager.getPlayer(targetId);
    const ended = victim?.streak ?? 0;
    if (victim) victim.streak = 0;
    if (targetId.startsWith('BOT-')) this.victimLine(targetId, shooterId);
    if (shooterId === 'environment') { this.witness(targetId); return; }
    // Self-splash reads as a death, not a frag — no streak credit, no
    // taunt, just the suicide notice.
    if (shooterId === targetId) {
      this.broadcast({ type: 'matchNotice', text: label === 'Respawn' ? `${targetId} respawned` : `${targetId} fragged themselves` });
      this.witness(targetId);
      return;
    }

    const shooter = this.playerManager.getPlayer(shooterId);
    if (!shooter) return;
    shooter.streak++;
    const revenge = this.lastKiller.get(shooterId) === targetId;
    this.lastKiller.set(targetId, shooterId);
    // Bounded grudges — a long-running room shouldn't bank one entry
    // per player who ever died.
    if (this.lastKiller.size > 256) this.lastKiller.clear();

    this.notices(shooterId, targetId, shooter.streak, ended);

    // Bots mouth off on the real chat wire — same 'chat' shape players
    // send, so it lands in the feed indistinguishable from a human line.
    // The specific edge (revenge, ending a streak) outranks a generic
    // kill line — it reads as noticing, not noise.
    if (shooterId.startsWith('BOT-')) {
      this.deathStreak.delete(shooterId);
      if (revenge) this.say(shooterId, 'revenge', targetId);
      else if (weapon === WeaponType.Melee) this.say(shooterId, 'fist', targetId);
      else if (ended >= 3) this.say(shooterId, 'streakend', targetId);
      else {
        const t = killTaunt(shooterId, targetId);
        this.botSay(shooterId, t?.text ?? null, true, t?.vgs);
      }
    }
  }

  /** The dead bot's half of announce: dying is +1 on the tilt counter
   *  (fragging resets it in announce) — three unanswered deaths earns
   *  the 'tilt' pool instead of the usual death/env line. */
  private victimLine(targetId: string, shooterId: string): void {
    const streak = (this.deathStreak.get(targetId) ?? 0) + 1;
    this.deathStreak.set(targetId, streak);
    if (this.deathStreak.size > 256) this.deathStreak.clear();
    if (streak >= 3) this.say(targetId, 'tilt', shooterId);
    else if (this.hardShot(targetId, shooterId)) this.say(targetId, 'props', shooterId);
    else {
      const t = shooterId === 'environment'
        ? envDeathTaunt(targetId)
        : deathTaunt(targetId, shooterId);
      this.botSay(targetId, t?.text ?? null, true, t?.vgs);
    }
  }

  /** Match notices for a scored frag: first blood once, the spree tier
   *  (with the bot crowing about it), godlike increments past the table,
   *  and the streak-ending callout. */
  private notices(shooterId: string, targetId: string, streak: number, ended: number): void {
    if (this.playerManager.killTotal() === 1) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} draws first blood` });
    }
    const tier = SPREE_TIERS.find(([n]) => n === streak);
    if (tier) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is on a ${tier[1]} (${tier[0]})` });
      if (shooterId.startsWith('BOT-')) {
        const t = spreeTaunt(shooterId);
        this.botSay(shooterId, t?.text ?? null, true, t?.vgs);
      }
    } else if (streak > 12 && streak % 4 === 0) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is godlike (${streak})` });
    }
    if (ended >= 3) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} ended ${targetId}'s ${ended}-kill streak` });
    }
  }

  /** Situation chatter from brains (contact/fear/bored/...) and flag
   *  events — kind resolves through the shared pools + cooldown, so a
   *  loud situation still obeys the per-bot throttle. */
  say(id: string, kind: ChatterKind, other?: string): void {
    if (!id.startsWith('BOT-')) return;
    // Replies don't invite replies — a bark→answer beat is the whole
    // trick; letting 'reply' chain would ping-pong the room forever.
    const c = chatter(kind, id, other);
    this.botSay(id, c?.text ?? null, kind !== 'reply', c?.vgs, c?.team);
  }

  /** Did the victim die to a hard shot? Long range or midair both count
   *  — the 'nice shot' compliment is earned, so it's a roll (~45%) on a
   *  qualifying kill, never a routine death response. */
  private hardShot(targetId: string, shooterId: string): boolean {
    if (tauntRand() > 0.45) return false;
    const victim = this.playerManager.getPlayer(targetId);
    const shooter = this.playerManager.getPlayer(shooterId);
    if (!victim?.position || !shooter?.position) return false;
    if (Math.abs(victim.velocity.y) > 10) return true; // died midair
    const dx = shooter.position.x - victim.position.x;
    const dy = shooter.position.y - victim.position.y;
    const dz = shooter.position.z - victim.position.z;
    return dx * dx + dy * dy + dz * dz > 70 * 70;
  }

  /** A bot died to terrain or its own blast — one nearby spectator gets
   *  the peanut-gallery roll. Proximity keeps it truthful: you mock the
   *  crater you actually watched happen. */
  private witness(targetId: string): void {
    const victim = this.playerManager.getPlayer(targetId);
    if (!victim?.position) return;
    const NEAR = 50;
    const near: string[] = [];
    for (const [id, p] of this.playerManager.getAllPlayers()) {
      if (!id.startsWith('BOT-') || id === targetId || p.isDead || !p.position) continue;
      const dx = p.position.x - victim.position.x, dz = p.position.z - victim.position.z;
      if (dx * dx + dz * dz < NEAR * NEAR) near.push(id);
    }
    if (!near.length) return;
    this.say(near[(tauntRand() * near.length) | 0]!, 'witness', targetId);
  }

  /** Match-end chatter — one rolled outcome line per bot, spread across
   *  the standings window so the lobby reads as staggered voices rather
   *  than a chorus. */
  matchEnd(entries: { id: string; line: TauntLine }[]): void {
    const step = entries.length > 1 ? Math.min(5000 / entries.length, 1200) : 0;
    entries.forEach((e, i) => this.botSay(e.id, e.line.text, true, e.line.vgs, false, 200 + i * step + tauntRand() * 400));
  }

  /** Match-start chatter — the gl-hf opener, tighter spread than the gg
   *  beat since the round is already live. */
  matchStart(entries: { id: string; line: TauntLine }[]): void {
    const step = entries.length > 1 ? Math.min(3000 / entries.length, 900) : 0;
    entries.forEach((e, i) => this.botSay(e.id, e.line.text, true, e.line.vgs, false, 100 + i * step + tauntRand() * 300));
  }

  /** A bot's chat line lands like a typed reply — a beat after the
   *  event, not inside the kill frame, and dropped if the speaker left
   *  the room meanwhile. Timers are tracked so room teardown can drain. */
  private botSay(id: string, line: string | null, inviteReply = true, vgs?: string, vgsTeam?: boolean, extraDelay = 0): void {
    if (!line) return;
    let delay = this.tauntDelayMs();
    // Typing pace — a two-letter "ez" lands fast, a gripe takes a beat.
    // Only when the host delays at all (tests pin 0 = instant speech).
    if (delay > 0) delay += Math.min(line.length * 35, 1400) + extraDelay;
    const speak = () => {
      if (!this.playerManager.getPlayer(id)) return;
      // Tactical VGS is team-scoped (canon); plain lines and VG*/VV*
      // chords go to everyone — a 'gg' answer must reach the human who
      // said it, whichever side they're on.
      const team = vgsTeam ? this.playerManager.getPlayer(id)?.team : undefined;
      if (team && this.sendToPlayer) {
        for (const [pid, q] of this.playerManager.getAllPlayers()) {
          if (q.team === team) this.sendToPlayer(pid, { type: 'chat', playerId: id, text: line, vgs, team: true });
        }
      } else {
        this.broadcast({ type: 'chat', playerId: id, text: line, vgs });
      }
      if (inviteReply) this.onBotSpoke?.(id);
    };
    if (delay <= 0) { speak(); return; }
    const t = setTimeout(() => { this.pending.delete(t); try { speak(); } catch (e) { logger.error('Bot taunt failed', { playerId: id, err: e instanceof Error ? e.message : String(e) }); } }, delay);
    this.pending.add(t);
  }

  /** Room teardown — drain queued taunts so a dead room can't speak. */
  dispose(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}
