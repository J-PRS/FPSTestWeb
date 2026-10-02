import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { TEAM_COLORS, TEAM_LABEL, FLAG_HOME_R, FLAG_RESET_S, bank, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import { roleObjective, ROLE_PRIORITY } from '../../../shared/flagGoals.js';
import * as sfx from '../core/sfx.js';

export interface Flag {
  mesh: THREE.Group; home: THREE.Vector3; pos: THREE.Vector3;
  state: 'home' | 'carried' | 'dropped'; carrier: string | null; dropT: number;
  /** Carrier's measured velocity — the flag rides the body, so the
   *  banner's own displacement IS the thief's velocity for aim lead. */
  vel: THREE.Vector3;
}

export interface FlagCtx {
  lazyTerrain(): Terrain;
  lazyScene(): THREE.Scene;
  /** id → pos for 'local' and bot playerIds; null when dead. */
  carrierPos(id: string): THREE.Vector3 | null;
  teamOf(id: string): string | undefined;
  /** Per-touch grab radius — the reach perk widens it (flag touch too). */
  pickupRadiusOf(id: string): number;
  /** Living toucher candidates: [id, pos, prevPos] triples — prevPos is
   *  last frame's spot so a fast graze sweeps a capsule, not a sphere. */
  touchers(): [string, THREE.Vector3, THREE.Vector3][];
  bots: GameBot[];
  scores: TeamScores;
  /** Capture landed — the referee pushes the HUD score. */
  onCapture(team: TeamId): void;
  onFeed(text: string): void;
  /** Flag state edge for cues — same beats the network path plays. */
  onFlagEvent?(kind: 'taken' | 'dropped' | 'returned' | 'captured', team: TeamId, at: THREE.Vector3): void;
}

const FLAG_POLE_GEO = new THREE.CylinderGeometry(0.06, 0.08, 4, 6);
const FLAG_POLE_MAT = new THREE.MeshBasicMaterial({ color: 0x888888 });
const FLAG_BANNER_GEO = new THREE.ConeGeometry(0.5, 1.2, 4);

/**
 * CTF flag entities — a pole + banner at each base, carried above a head,
 * dropped on death, returned on own-team touch. All mode rules live here;
 * TeamBots only bridges it to the roster/score.
 */
export class CtfFlags {
  private flags: Map<TeamId, Flag> = new Map();

  constructor(private ctx: FlagCtx, around: THREE.Vector3) {
    // Bases sit on the X axis around the player spawn — readable landmarks.
    const terrain = ctx.lazyTerrain();
    for (const team of ['alpha', 'bravo'] as TeamId[]) {
      const sign = team === 'alpha' ? -1 : 1;
      const home = new THREE.Vector3(around.x + sign * 70, 0, around.z);
      home.y = terrain.getHeight(home.x, home.z);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(FLAG_POLE_GEO, FLAG_POLE_MAT);
      const banner = new THREE.Mesh(FLAG_BANNER_GEO, new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] }));
      banner.position.set(0.55, 3.4, 0);
      pole.position.y = 2;
      g.add(pole, banner);
      g.position.copy(home);
      ctx.lazyScene().add(g);
      this.flags.set(team, { mesh: g, home, pos: home.clone(), state: 'home', carrier: null, dropT: 0, vel: new THREE.Vector3() });
    }
  }

  /** Flag positions for the HUD markers — DOM overlay, reads every frame. */
  markers(): { team: TeamId; pos: THREE.Vector3 }[] {
    const out: { team: TeamId; pos: THREE.Vector3 }[] = [];
    for (const [team, f] of this.flags) out.push({ team, pos: f.pos });
    return out;
  }

  // Offline roles — the same shared/flagGoals.ts table ServerBots uses,
  // minus technician (no deploy kit locally). Infiltrator IS supported:
  // the cloak intent rides GameBot.applyStatus like anywhere else.
  // Without roles every bot read the same objective and the whole squad
  // ran the same flag route — nobody held the stand.
  private roles = new Map<string, 'capper' | 'ldefense' | 'hof' | 'offense' | 'defense' | 'infiltrator'>();
  private roleT = 0;
  // Offline bots DO carry the cloak intent (GameBot.applyStatus →
  // STATUS.CLOAK → setCloakHidden), so the infiltrator lane is playable
  // locally too — technician alone stays server-only (no deploy kit).
  private static readonly SUPPORTED = new Set(['capper', 'ldefense', 'hof', 'infiltrator']);

  private rebalanceRoles(now: number): void {
    if (now < this.roleT) return;
    this.roleT = now + 5000;
    const byTeam = new Map<TeamId, string[]>();
    for (const b of this.ctx.bots) {
      const t = b.team as TeamId;
      if (t === 'alpha' || t === 'bravo') (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(b.playerId);
    }
    const WANT = ROLE_PRIORITY.filter((w) => CtfFlags.SUPPORTED.has(w.role));
    for (const ids of byTeam.values()) {
      const free = ids.filter((id) => {
        for (const f of this.flags.values()) if (f.carrier === id) return false;
        return true;
      });
      // Specialists are sticky: donors only come from the generic pool
      // (offense/defense), and a body is consumed once per cycle.
      const isSpecial = (id: string) => WANT.some((w) => this.roles.get(id) === w.role);
      const donors = free.filter((id) => !isSpecial(id));
      for (const { role, want, minSquad } of WANT) {
        if (ids.length < minSquad) break;
        let have = ids.filter((id) => this.roles.get(id) === role).length;
        while (have < want) {
          const donor = donors.shift();
          if (!donor) break;
          this.roles.set(donor, role as 'capper' | 'ldefense' | 'hof' | 'infiltrator');
          have++;
        }
      }
      // Everyone not assigned a specialist slot is offense/defense by
      // squad parity — the home side never empties completely.
      let d = 0;
      for (const id of free) {
        if (!this.roles.has(id)) this.roles.set(id, d++ % 2 === 0 ? 'offense' : 'defense');
      }
    }
  }

  /** Where a flag-focused bot should run — the shared role table
   *  (shared/flagGoals.ts) resolved against this room's flag state. */
  objectiveFor(bot: GameBot): THREE.Vector3 | null {
    const info = this.objectiveInfoFor(bot);
    return info ? info.pos : null;
  }

  /** Objective + whether the bot is rushing the enemy stand — the
   *  infiltrating flag the server feeds its brains (cloak skill).
   *  When the role's pick IS the thief, the carrier rides along as a
   *  beacon-marked enemy so the brain engages him, not just the spot. */
  objectiveInfoFor(bot: GameBot): { pos: THREE.Vector3; infiltrating: boolean;
      running?: boolean;
      thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } } | null {
    const enemyTeam: TeamId = bot.team === 'alpha' ? 'bravo' : 'alpha';
    const enemy = this.flags.get(enemyTeam);
    const own = this.flags.get(bot.team as TeamId);
    if (!enemy || !own) return null;
    if (bot.carryingFlag) return { pos: own.home.clone(), infiltrating: false, running: true };
    const role = this.roles.get(bot.playerId) ?? 'offense';
    const thief = own.state === 'carried' && own.carrier ? this.ctx.carrierPos(own.carrier) : null;
    const escortPos = enemy.carrier ? this.ctx.carrierPos(enemy.carrier) : null;
    const enemyStand = enemy.state !== 'carried' ? enemy.pos : null;
    const pick = roleObjective(role, {
      home: own.home,
      thief,
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: escortPos,
      threat: this.standThreat(own.home, bot.team as string),
    }, bot.dutyLevel);
    // Cloak intent is the infiltrator's alone — the drain is
    // speed-scaled, so a sprinting capper would arrive tank-dry.
    const infiltrating = enemyStand !== null && pick === enemyStand && role === 'infiltrator';
    return {
      pos: new THREE.Vector3(pick.x, pick.y, pick.z), infiltrating,
      // Only roles whose goal IS the thief get the beacon — a capper
      // escorting doesn't break off to chase.
      thief: this.thiefBeacon(thief, pick, own),
    };
  }

  /** Closest hostile inside the home ring — the HoF's body-block
   *  anchor. touchers() includes the local player, so a human pressing
   *  the stand draws the lean too. */
  private standThreat(home: THREE.Vector3, myTeam: string): { x: number; y: number; z: number } | null {
    let best: THREE.Vector3 | null = null, bestD = 45;
    for (const [id, pos] of this.ctx.touchers()) {
      if (this.ctx.teamOf(id) === myTeam) continue;
      const d = Math.hypot(pos.x - home.x, pos.z - home.z);
      if (d < bestD) { bestD = d; best = pos; }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  private thiefBeacon(thief: THREE.Vector3 | null, pick: { x: number; y: number; z: number }, own: Flag) {
    return thief !== null && pick === thief && own.carrier
      ? { id: own.carrier, pos: thief, vel: own.vel } : undefined;
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const [team, f] of this.flags) {
      if (f.carrier !== carrierId) continue;
      f.carrier = null;
      f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.ctx.lazyTerrain().getHeight(at.x, at.z);
      f.dropT = FLAG_RESET_S;
      const bot = this.ctx.bots.find(b => b.playerId === carrierId);
      if (bot) bot.carryingFlag = false;
      this.ctx.onFlagEvent?.('dropped', team, f.pos);
    }
  }

  /** Match reset — every flag home, nobody carrying. */
  reset(): void {
    for (const f of this.flags.values()) {
      f.state = 'home'; f.carrier = null; f.pos.copy(f.home); f.mesh.position.copy(f.home);
    }
  }

  update(dt: number): void {
    this.rebalanceRoles(performance.now());
    for (const [team, f] of this.flags) {
      const px = f.pos.x, py = f.pos.y, pz = f.pos.z;
      if (f.state === 'carried') this.tickCarried(team, f);
      else if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) { f.state = 'home'; f.pos.copy(f.home); }
      }
      // Touch rules: enemy team grabs it, own team returns a dropped flag.
      if (f.state === 'carried') {
        if (dt > 0) f.vel.set((f.pos.x - px) / dt, (f.pos.y - py) / dt, (f.pos.z - pz) / dt);
        f.mesh.position.copy(f.pos);
        continue;
      }
      this.tickTouch(team, f);
      f.mesh.position.copy(f.pos);
    }
  }

  // Carried flag rides the carrier; scoring the cap requires the carrier's
  // own flag home — the standoff rule that makes flag-defense matter.
  private tickCarried(team: TeamId, f: Flag): void {
    const ctx = this.ctx;
    const cp = f.carrier ? ctx.carrierPos(f.carrier) : null;
    if (!cp) { f.carrier = null; f.state = 'dropped'; f.dropT = FLAG_RESET_S; return; }
    f.pos.set(cp.x, cp.y + 1.2, cp.z); // rides above the carrier's head
    const carrierTeam = ctx.teamOf(f.carrier!) as TeamId;
    if (carrierTeam === team) return;
    const ownBase = this.flags.get(carrierTeam)!;
    if (ownBase.state !== 'home' || cp.distanceTo(ownBase.home) >= FLAG_HOME_R) return;
    bank(ctx.scores, carrierTeam);
    ctx.onCapture(carrierTeam);
    ctx.onFlagEvent?.('captured', team, f.home);
    ctx.onFeed(`${f.carrier === 'local' ? 'YOU' : f.carrier!.replace('bot:', '')} captured the ${TEAM_LABEL[team]} flag!`);
    if (f.carrier === 'local') sfx.pickup();
    const bot = ctx.bots.find(b => b.playerId === f.carrier);
    if (bot) bot.carryingFlag = false;
    f.carrier = null; f.state = 'home'; f.pos.copy(f.home);
  }

  private tickTouch(team: TeamId, f: Flag): void {
    const ctx = this.ctx;
    for (const [id, tp, pp] of ctx.touchers()) {
      const tTeam = ctx.teamOf(id);
      // Swept grab: the reach is tested against the whole frame's travel
      // (prev→cur), so a 60m/s fly-by can't tunnel between samples.
      const segLen2 = pp.distanceToSquared(tp);
      const t = segLen2 > 0
        ? Math.min(1, Math.max(0,
            ((f.pos.x - pp.x) * (tp.x - pp.x) + (f.pos.y - pp.y) * (tp.y - pp.y) + (f.pos.z - pp.z) * (tp.z - pp.z)) / segLen2))
        : 0;
      const dx = pp.x + (tp.x - pp.x) * t - f.pos.x;
      const dy = pp.y + (tp.y - pp.y) * t - f.pos.y;
      const dz = pp.z + (tp.z - pp.z) * t - f.pos.z;
      if (dx * dx + dy * dy + dz * dz > this.ctx.pickupRadiusOf(id) ** 2) continue;
      if (f.state === 'dropped' && tTeam === team) {
        f.state = 'home'; f.pos.copy(f.home); // returned on touch
        ctx.onFlagEvent?.('returned', team, f.pos);
        return;
      }
      if (tTeam !== team) {
        ctx.onFlagEvent?.('taken', team, f.pos);
        f.state = 'carried'; f.carrier = id;
        const bot = ctx.bots.find(b => b.playerId === id);
        if (bot) bot.carryingFlag = true;
        ctx.onFeed(`${id === 'local' ? 'YOU' : id.replace('bot:', '')} took the ${TEAM_LABEL[team]} flag!`);
        return;
      }
    }
  }
}
