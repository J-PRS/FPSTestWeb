import { wallMs } from './wallClock.ts';
import type { PlayerState, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { RoomPickups } from './RoomPickups.ts';
import type { RoomFlags } from './RoomFlags.ts';
import type { RoomDeployables } from './RoomDeployables.ts';
import {type Heightfield, hmHeight} from '../../shared/heightfield.ts';
import { bank, winner, CTF_PTS, CTF_DMG_PER_PTS, CTF_FLAG_ZONE_R, type ModeSpec, type TeamScores, type TeamId } from '../../shared/teams.ts';
import { POWERUP, rollCreatureDrop, decomposeTokens, type PowerupKind } from '../../shared/pickups.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { logger } from './logger.ts';
import { healPool } from './healPool.ts';
import { simNow , simMs} from './simClock.ts';
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
    return [...this.h.players.getAllPlayers().values()].map((p): { id: string; team: TeamId | undefined; kills: number; deaths: number; } => ({
      id: p.id, team: p.team, kills: p.kills, deaths: p.deaths,
    }));
  }

  /** Non-player kill — fed by both non-player sims: BallSim balls (`b:`
   *  ids) and CreatureSim species pops. FFA modes award the killer directly;
   *  team modes drop a nugget at the corpse that anyone must touch to
   *  bank (kill-confirmed style scoring). */
  nonPlayerKill(by: string, pos: Vec3, variant = 0): void {
    // The economy runs on kills — soak validation needs these visible.
    logger.debug('Creature killed', { room: this.h.name, by, variant });
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
      for (let i = 0; i < drops; i += 1) {
        const gx2 = pos.x + dx + (this.h.rng() - 0.5) * 2;
        const gz2 = pos.z + dz + (this.h.rng() - 0.5) * 2;
        const gy2 = (this.h.field ? hmHeight(this.h.field, gx2, gz2) : pos.y) + 0.5;
        // Launch from the corpse with real velocity so the server's tumble
        // owns the arc — a ground-level zero-vel spawn made clients invent it.
        const launch = { x: dx * 2 + (this.h.rng() - 0.5) * 3, y: 4 + this.h.rng() * 2, z: dz * 2 + (this.h.rng() - 0.5) * 3 };
        this.h.pickups?.spawn({ x: pos.x, y: pos.y + 0.5, z: pos.z }, this.h.mode === 'headhunt' ? 'token' : 'gem', 0, 1, undefined, 0, launch);
        this.h.influence.splat({ x: gx2, y: gy2, z: gz2 }, 'opportunity', 0.5);
      }
      return;
    }
    if (!spec?.ffa || spec.ptsCreatureKill <= 0 || !this.h.players.getPlayer(by)) {return;}
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
      p.regenUntil = simMs(now + POWERUP.regenMs);
      buff.until = p.regenUntil;
    } else {
      p.ddUntil = simMs(now + POWERUP.ddMs);
      buff.until = p.ddUntil;
    }
    p.forceSendUntil = wallMs(now + 500); // buffed health/status rides the next ticks
    this.h.sendToPlayer(p.id, buff);
  }

  /** Kill hook from the damage funnel: flag drop in every mode, frag
   *  points in FFA rooms. 'environment' shooters score nothing. */
  onKill(targetId: string, shooterId: string): void {
    this.h.flagCarrierDied(targetId);
    this.h.deployables.clearOwner(targetId);
    // A death is audible — nearby idle bots drift toward the kill spot.
    const corpse = this.h.players.getPlayer(targetId);
    if (corpse) {this.h.pushNoise(corpse.position);}
    const spec = this.h.modeSpec;
    // Corpse loot — offline drops 3 nuggets on every team-mode death
    // ("kills feed the economy"); the wire must match or hosted rooms
    // starve on maps without creature pops. Runs before the shooter
    // checks: environment/self kills leave loot too, same as offline.
    // tdm keeps its single kill-confirm tag; other team modes scatter
    // gems (belt income + heal — they only bank points where
    // modeSpec.gems says so).
    if (spec?.teams && corpse) {
      if (this.h.mode === 'tdm') {
        // Kill-confirmed: ANY team grabs the tag for the point —
        // deny by touching it first.
        this.h.pickups?.spawn(corpse.position, 'tag', 0, 1, undefined, 0, { x: corpse.velocity.x * 0.5, y: corpse.velocity.y * 0.5, z: corpse.velocity.z * 0.5 });
        this.h.influence.splat(corpse.position, 'opportunity', 0.5);
      } else if (this.h.mode === 'headhunt') {
        // Every held token comes back out plus one corpse bounty —
        // base-3 coins, so a 10-hoard scatters 9+1+1 (blue + two
        // whites), not eleven singles. Killing a hoarder swings the
        // live scoreboard in one burst — the mode's whole point.
        const coins = decomposeTokens(corpse.heldTokens + 1);
        this.setHeld(corpse, 0);
        // FPS_HH_REGRAB_LOCK_S (experiment): the victim's own team can't
        // regrab its scatter for N sim-seconds — breaks the
        // die-at-home-recycle loop the hhEvo ladder exposed. 0 = off.
        const lockS = Number(process.env.FPS_HH_REGRAB_LOCK_S ?? 0);
        for (const val of coins) {
          this.h.pickups?.spawn({
            x: corpse.position.x + (this.h.rng() - 0.5) * 3,
            y: corpse.position.y,
            z: corpse.position.z + (this.h.rng() - 0.5) * 3,
          }, 'token', 0, val, lockS > 0 ? corpse.team : undefined, lockS, { x: corpse.velocity.x * 0.5, y: corpse.velocity.y * 0.5, z: corpse.velocity.z * 0.5 });
        }
        this.h.influence.splat(corpse.position, 'opportunity', 0.5);
      } else {
        for (let i = 0; i < 3; i += 1) {
          this.h.pickups?.spawn({
            x: corpse.position.x + (this.h.rng() - 0.5) * 3,
            y: corpse.position.y,
            z: corpse.position.z + (this.h.rng() - 0.5) * 3,
          }, 'gem', 0, 1, undefined, 0, { x: corpse.velocity.x * 0.5, y: corpse.velocity.y * 0.5, z: corpse.velocity.z * 0.5 });
        }
      }
    }
    const shooter = this.h.players.getPlayer(shooterId);
    if (!spec || !shooter) {return;}
    // Self-splash is a death, not a frag — kills/deaths still record,
    // but a suicide must never pay a point toward winning.
    if (shooterId === targetId) {return;}
    // CTF personal board: a frag pays 1, doubled when the victim was in
    // a flag zone (defending your stand or clearing the enemy's). Runs
    // BEFORE the ptsPlayerKill gate — ctf sets that to 0 because frags
    // never moved the TEAM score, but personal points still pay.
    if (spec.teams && spec.flags) {
      const victim = this.h.players.getPlayer(targetId);
      const inZone = victim ? this.h.flags?.nearStand(victim.position, CTF_FLAG_ZONE_R) : false;
      this.awardPersonal(shooterId, inZone ? CTF_PTS.flagZoneKill : CTF_PTS.kill);
    }
    if (spec.ptsPlayerKill <= 0) {return;}
    if (spec.ffa) {this.awardFfa(shooterId, spec.ptsPlayerKill);}
    else if (shooter.team) {this.score(shooter.team, spec.ptsPlayerKill);}
  }

  /** CTF damage economy — every 100 post-mitigation enemy damage pays 1
   *  personal pt (T2's damage-points). Chained through the hit EVENT, not
   *  applyHit, so environment/self/friendly damage never lands here:
   *  friendly fire is gated upstream and self-hits fail the id check.
   *  The pool keeps the remainder — chip damage across lives still pays. */
  private dmgPool = new Map<string, number>();
  onDamage(shooterId: string, targetId: string, damage: number): void {
    const spec = this.h.modeSpec;
    if (!spec?.teams || !spec.flags || shooterId === targetId) {return;}
    const shooter = this.h.players.getPlayer(shooterId);
    const victim = this.h.players.getPlayer(targetId);
    if (!shooter?.team || !victim?.team || shooter.team === victim.team) {return;}
    const acc = (this.dmgPool.get(shooterId) ?? 0) + damage;
    const pts = Math.floor(acc / CTF_DMG_PER_PTS);
    this.dmgPool.set(shooterId, acc - pts * CTF_DMG_PER_PTS);
    if (pts > 0) {this.awardPersonal(shooterId, pts * CTF_PTS.dmg);}
  }

  /** Headhunt: the only writer for heldTokens — the count change and
   *  the score resync travel together so a silent reset (respawn wipe,
   *  match boundary, team swap) still flushes truth to the wire. */
  setHeld(p: PlayerState, n: number): void {
    p.heldTokens = n;
    this.syncHeld();
  }

  /** Last broadcast count per player — the diff that decides which
   *  playerHeld edges go out. */
  private heldEchoed = new Map<string, number>();

  /** Recompute the live team scores from held tokens (score = held,
   *  never banked) and broadcast playerHeld for anyone whose count
   *  changed since the last echo. No-op outside headhunt. */
  syncHeld(): void {
    if (this.h.mode !== 'headhunt') {return;}
    let a = 0;
    let b = 0;
    for (const p of this.h.players.getAllPlayers().values()) {
      if (this.heldEchoed.get(p.id) !== p.heldTokens) {
        this.heldEchoed.set(p.id, p.heldTokens);
        this.h.broadcast({ type: 'playerHeld', playerId: p.id, n: p.heldTokens } as ServerMessage);
      }
      if (p.team === 'alpha') {a += p.heldTokens;}
      else if (p.team === 'bravo') {b += p.heldTokens;}
    }
    const s = this.h.scores;
    if (s.alpha !== a || s.bravo !== b) {
      s.alpha = a;
      s.bravo = b;
      this.h.broadcast({ type: 'teamScore', scores: { alpha: a, bravo: b }, winAt: this.h.modeSpec!.winAt } as ServerMessage);
      const w = winner(s, this.h.modeSpec!.winAt);
      if (w) {this.h.endMatch(w);}
    }
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: TeamId, n = 1): void {
    if (!this.h.modeSpec?.teams) {return;}
    bank(this.h.scores, team, n);
    this.h.broadcast({ type: 'teamScore', scores: Object.assign({}, this.h.scores), winAt: this.h.modeSpec.winAt });
    const w = winner(this.h.scores, this.h.modeSpec.winAt);
    if (w) {this.h.endMatch(w);}
  }

  /** Rabbit's bottom-feeder rule: exactly ONE last-place hunter may brawl
   *  with anyone. Ties break on player id — every-min-tie used to exempt
   *  the whole field, which left hunter-vs-hunter legal all game. */
  bottomFeeders(): Set<string> {
    let bottom: string | null = null;
    let min = Infinity;
    for (const p of this.h.players.getAllPlayers().values()) {
      const s = this.ffaScores.get(p.id) ?? 0;
      if (s < min || (s === min && bottom !== null && p.id < bottom)) {
        min = s;
        bottom = p.id;
      }
    }
    return bottom === null ? new Set() : new Set([bottom]);
  }

  /** Objective-time payout (rabbit hold ticks) — same broadcast +
   *  win-check funnel as frag points. */
  grantFfa(id: string, n: number): void { this.awardFfa(id, n); }

  private awardFfa(id: string, n: number): void {
    const spec = this.h.modeSpec!;
    const pts = (this.ffaScores.get(id) ?? 0) + n;
    this.ffaScores.set(id, pts);
    this.h.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: spec.winAt });
    if (pts >= spec.winAt) {this.h.endMatch(id);}
  }

  /** Team-mode personal score — same ffaScores map + ffaScore echo, but
   *  it can NEVER end a match: the PTS column is honor, not the win. */
  awardPersonal(id: string, n: number): void {
    const spec = this.h.modeSpec;
    if (!spec) {return;}
    this.ffaScores.set(id, (this.ffaScores.get(id) ?? 0) + n);
    this.h.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: spec.winAt });
  }

  /** Player removal — drop their FFA row and re-echo the board if it
   *  had one. */
  dropPlayer(playerId: string): void {
    this.dmgPool.delete(playerId); // unbanked chip dies with the seat
    this.heldEchoed.delete(playerId); // their tokens leave the live sum too
    this.syncHeld();
    if (this.ffaScores.delete(playerId)) {
      this.h.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: this.h.modeSpec!.winAt });
    }
  }
}
