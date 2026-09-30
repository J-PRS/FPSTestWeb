import type { PlayerState, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { RoomPickups } from './RoomPickups.ts';
import type { RoomFlags } from './RoomFlags.ts';
import type { RoomDeployables } from './RoomDeployables.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { bank, winner, type ModeSpec, type TeamScores } from '../../shared/teams.ts';
import { POWERUP, rollCreatureDrop, type PowerupKind } from '../../shared/pickups.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { logger } from './logger.ts';

// Score/kill economy — every path that turns a death or a touch into
// points, pickups, or the match horn. Split from Room.ts so the room file
// stays wiring; the host supplies the world surface these rules read.

export interface ScoreHost {
  name: string;
  modeSpec: ModeSpec | null;
  mode: string;
  scores: TeamScores;
  players: PlayerManager;
  pickups: RoomPickups | null;
  flags: RoomFlags | null;
  deployables: RoomDeployables;
  field: Heightfield | null;
  rng(): number;
  broadcast(msg: ServerMessage, exclude?: string): void;
  sendToPlayer(playerId: string, msg: ServerMessage): void;
  pushNoise(pos: Vec3): void;
  endMatch(w: string): void;
  flagCarrierDied(playerId: string): void;
}

export class RoomScore {
  /** Per-player scoreboard for FFA modes (dm). Bots are in the same map —
   *  a bot can legitimately win a deathmatch. */
  readonly ffaScores = new Map<string, number>();

  constructor(private h: ScoreHost) {}

  /** Per-player K/D at the horn — the match journal's useful payload. */
  matchPlayers(): { id: string; team?: string; kills: number; deaths: number }[] {
    return [...this.h.players.getAllPlayers().values()].map((p) => ({
      id: p.id, team: p.team, kills: p.kills, deaths: p.deaths,
    }));
  }

  /** Creature kill — ballDie attribution from BallSim. FFA modes award
   *  the killer directly; team modes drop a nugget at the corpse that
   *  anyone must touch to bank (kill-confirmed style scoring). */
  creatureKill(by: string, pos: Vec3, variant = 0): void {
    // The economy runs on kills — soak validation needs these visible.
    logger.info('Creature killed', { room: this.h.name, by, variant });
    // Powerup drops roll in EVERY mode — the pickup does the granting.
    const powerup = rollCreatureDrop();
    // Creatures die mid-flight — the drop must land on the ground or the
    // dy<=6 pickup grab can never reach it and the economy starves.
    const gy = (this.h.field ? hmHeight(this.h.field, pos.x, pos.z) : pos.y) + 0.5;
    if (powerup) {
      this.h.pickups?.spawn({ x: pos.x + (this.h.rng() - 0.5) * 2, y: gy, z: pos.z + (this.h.rng() - 0.5) * 2 }, powerup);
    }
    const spec = this.h.modeSpec;
    if (spec?.teams) {
      // Pay for the corpse's threat: variant 3 elites and v2 tanks drop a
      // burst, fodder still drops one (same scale curve the client uses).
      const drops = [1, 2, 3, 3][variant] ?? 1;
      for (let i = 0; i < drops; i++) {
        this.h.pickups?.spawn({ x: pos.x + (this.h.rng() - 0.5) * 2, y: gy, z: pos.z + (this.h.rng() - 0.5) * 2 });
      }
      return;
    }
    if (!spec?.ffa || spec.ptsCreatureKill <= 0 || !this.h.players.getPlayer(by)) return;
    this.awardFfa(by, spec.ptsCreatureKill);
  }

  /** Powerup pickup resolution — buffs are server-owned so a client can
   *  never claim regen/dd it didn't touch. Bots collect too: they read
   *  the fields directly, no wire message needed for them. */
  applyPowerup(p: PlayerState, kind: PowerupKind): void {
    const now = Date.now();
    const buff: Extract<ServerMessage, { type: 'buff' }> = { type: 'buff', kind };
    if (kind === 'heal') {
      p.health = Math.min(p.maxHealth, p.health + POWERUP.heal);
      buff.health = p.health;
    } else if (kind === 'armor') {
      p.armor = Math.min(POWERUP.maxArmor, p.armor + POWERUP.armor);
      buff.armor = p.armor;
    } else if (kind === 'regen') {
      p.regenUntil = now + POWERUP.regenMs;
      buff.until = p.regenUntil;
    } else {
      p.ddUntil = now + POWERUP.ddMs;
      buff.until = p.ddUntil;
    }
    p.forceSendUntil = now + 500; // buffed health/status rides the next ticks
    this.h.sendToPlayer(p.id, buff);
  }

  /** Kill hook from the damage funnel: flag drop in every mode, frag
   *  points in FFA rooms. 'environment' shooters score nothing. */
  onKill(targetId: string, shooterId: string): void {
    this.h.flagCarrierDied(targetId);
    this.h.deployables.clearOwner(targetId);
    // A death is audible — nearby idle bots drift toward the kill spot.
    const corpse = this.h.players.getPlayer(targetId);
    if (corpse) this.h.pushNoise(corpse.position);
    const spec = this.h.modeSpec;
    const shooter = this.h.players.getPlayer(shooterId);
    if (!spec || !shooter || spec.ptsPlayerKill <= 0) return;
    if (spec.ffa) this.awardFfa(shooterId, spec.ptsPlayerKill);
    else if (shooter.team) {
      this.score(shooter.team, spec.ptsPlayerKill);
      // Kill-confirmed mode (tdm): the corpse drops a tag that ANY team
      // can pick up for another point — deny by grabbing it first.
      const t = this.h.players.getPlayer(targetId);
      if (this.h.mode === 'tdm' && t) this.h.pickups?.spawn(t.position, 'tag');
    }
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: 'alpha' | 'bravo', n = 1): void {
    if (!this.h.modeSpec?.teams) return;
    bank(this.h.scores, team, n);
    this.h.broadcast({ type: 'teamScore', scores: { ...this.h.scores }, winAt: this.h.modeSpec.winAt });
    const w = winner(this.h.scores, this.h.modeSpec.winAt);
    if (w) this.h.endMatch(w);
  }

  private awardFfa(id: string, n: number): void {
    const spec = this.h.modeSpec!;
    const pts = (this.ffaScores.get(id) ?? 0) + n;
    this.ffaScores.set(id, pts);
    this.h.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: spec.winAt });
    if (pts >= spec.winAt) this.h.endMatch(id);
  }

  /** Player removal — drop their FFA row and re-echo the board if it
   *  had one. */
  dropPlayer(playerId: string): void {
    if (this.ffaScores.delete(playerId)) {
      this.h.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: this.h.modeSpec!.winAt });
    }
  }
}
