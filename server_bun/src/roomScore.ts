import type { PlayerState, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { RoomPickups } from './RoomPickups.ts';
import type { RoomFlags } from './RoomFlags.ts';
import type { RoomDeployables } from './RoomDeployables.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { bank, winner, type ModeSpec, type TeamScores, type TeamId } from '../../shared/teams.ts';
import { POWERUP, rollCreatureDrop, type PowerupKind } from '../../shared/pickups.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { logger } from './logger.ts';
import { healPool } from './healPool.ts';
import { simNow } from './simClock.ts';
import type { InfluenceMap } from './influenceMap.ts';

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
  influence: InfluenceMap;
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

  /** Non-player kill — fed by both non-player sims: BallSim balls (`b:`
   *  ids) and CreatureSim species pops. FFA modes award the killer directly;
   *  team modes drop a nugget at the corpse that anyone must touch to
   *  bank (kill-confirmed style scoring). */
  nonPlayerKill(by: string, pos: Vec3, variant = 0): void {
    // The economy runs on kills — soak validation needs these visible.
    logger.info('Creature killed', { room: this.h.name, by, variant });
    // Powerup drops roll in EVERY mode — the pickup does the granting.
    const powerup = rollCreatureDrop(this.h.rng(), this.h.rng());
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
      // Loot drifts toward the kill shot — corpses fall where balls
      // roam, so an unbiased spawn decays in dead corners; landing the
      // gem partway to the shooter puts it on a path someone walks.
      const killer = this.h.players.getPlayer(by);
      const k = killer ? 0.45 : 0;
      const dx = k * (killer!.position.x - pos.x), dz = k * (killer!.position.z - pos.z);
      for (let i = 0; i < drops; i++) {
        const gx2 = pos.x + dx + (this.h.rng() - 0.5) * 2;
        const gz2 = pos.z + dz + (this.h.rng() - 0.5) * 2;
        const gy2 = (this.h.field ? hmHeight(this.h.field, gx2, gz2) : pos.y) + 0.5;
        this.h.pickups?.spawn({ x: gx2, y: gy2, z: gz2 });
        this.h.influence.splat({ x: gx2, y: gy2, z: gz2 }, 'opportunity', 0.5);
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
    const now = simNow();
    const buff: Extract<ServerMessage, { type: 'buff' }> = { type: 'buff', kind };
    if (kind === 'heal') {
      healPool(p, POWERUP.heal);
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
      if (this.h.mode === 'tdm' && t) {
        this.h.pickups?.spawn(t.position, 'tag');
        this.h.influence.splat(t.position, 'opportunity', 0.5);
      }
    }
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: TeamId, n = 1): void {
    if (!this.h.modeSpec?.teams) return;
    bank(this.h.scores, team, n);
    this.h.broadcast({ type: 'teamScore', scores: { ...this.h.scores }, winAt: this.h.modeSpec.winAt });
    const w = winner(this.h.scores, this.h.modeSpec.winAt);
    if (w) this.h.endMatch(w);
  }

  /** Rabbit's bottom-feeder rule: everyone tied for the LEAST points is
   *  last place — those hunters get open season. A full-field tie means
   *  nobody is uniquely behind, so nobody earns the exemption. */
  bottomFeeders(): Set<string> {
    const out = new Set<string>();
    const ids: string[] = [];
    let min = Infinity;
    for (const p of this.h.players.getAllPlayers().values()) {
      const s = this.ffaScores.get(p.id) ?? 0;
      ids.push(p.id);
      if (s < min) min = s;
    }
    for (const id of ids) if ((this.ffaScores.get(id) ?? 0) === min) out.add(id);
    return out.size === ids.length ? new Set() : out;
  }

  /** Objective-time payout (rabbit hold ticks) — same broadcast +
   *  win-check funnel as frag points. */
  grantFfa(id: string, n: number): void { this.awardFfa(id, n); }

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
