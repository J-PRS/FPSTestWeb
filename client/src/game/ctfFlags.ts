import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { TEAM_COLORS, TEAM_LABEL, FLAG_HOME_R, FLAG_RESET_S, CTF_PTS, bank, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import { roleObjective, ROLE_PRIORITY, STRICT_CLASS } from '../../../shared/flagGoals.js';
import * as sfx from '../core/sfx.js';
import { mkFlagStand, FLAG_STAND_TOP } from '../structures/structures.js';
import { flagStandSpecs, FLAG_STAND_LIFT } from '../../../shared/mapSpec.js';

export interface Flag {
  /** The movable piece — pole + banner + finial; rides carriers and drops. */
  mesh: THREE.Group;
  /** The permanent piece — just the gem socket planted at home. A bare
   *  socket is the "flag's out" read; it never moves. */
  stand: THREE.Group;
  home: THREE.Vector3; pos: THREE.Vector3;
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
  /** Personal-score payout — mirrors the server's CTF_PTS awards so the
   *  offline board's PTS column credits objective work too. */
  onPersonalPoints?(id: string, pts: number): void;
  /** Offline collision: the dais hulls as structure specs — the bridge
   *  pushes them into the local player's and bots' move sims. */
  applyStandSpecs?(specs: import('../../../shared/mapSpec.js').StructureSpec[]): void;
}

const FLAG_POLE_GEO = new THREE.CylinderGeometry(0.06, 0.08, 4, 6);
const FLAG_POLE_MAT = new THREE.MeshBasicMaterial({ color: 0x888888 });
const FLAG_BANNER_GEO = new THREE.ConeGeometry(0.5, 1.2, 4);
const FLAG_BASE_GEO = new THREE.IcosahedronGeometry(0.4, 0);
const FLAG_FINIAL_GEO = new THREE.IcosahedronGeometry(0.14, 0);

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
    const standSpecs: import('../../../shared/mapSpec.js').StructureSpec[] = [];
    for (const team of ['alpha', 'bravo'] as TeamId[]) {
      const sign = team === 'alpha' ? -1 : 1;
      const home = new THREE.Vector3(around.x + sign * 70, 0, around.z);
      home.y = terrain.getHeight(home.x, home.z);
      standSpecs.push(...flagStandSpecs(home, team));
      // Stand (bare gem socket) is planted once at home and never moves;
      // the flag (pole + banner + finial) is the ripped-out piece —
      // home reseats the pole in the socket so the pair reads as one flag.
      const stand = mkFlagStand(TEAM_COLORS[team]);
      const base = new THREE.Mesh(FLAG_BASE_GEO,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(1.4) }));
      base.position.y = FLAG_STAND_TOP + 0.07; // gem in the socket well
      stand.add(base);
      stand.position.copy(home);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(FLAG_POLE_GEO, FLAG_POLE_MAT);
      pole.position.y = 2;
      const banner = new THREE.Mesh(FLAG_BANNER_GEO, new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] }));
      banner.position.set(0.55, 3.4, 0);
      const finial = new THREE.Mesh(FLAG_FINIAL_GEO,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(1.4) }));
      finial.position.y = 4.05;
      g.add(banner, finial);
      g.position.copy(home);
      g.position.y += FLAG_STAND_TOP; // pole seats on the platform deck
      ctx.lazyScene().add(stand, g);
      this.flags.set(team, { mesh: g, stand, home, pos: home.clone(), state: 'home', carrier: null, dropT: 0, vel: new THREE.Vector3() });
    }
    ctx.applyStandSpecs?.(standSpecs);
  }

  /** Flag + stand positions for the HUD markers — DOM overlay, reads
   *  every frame. `pos` is the flag (diamond); `home` is the stand
   *  (hollow socket). They coincide while the flag is home. */
  markers(): { team: TeamId; pos: THREE.Vector3; home: THREE.Vector3; state: Flag['state'] }[] {
    const out: { team: TeamId; pos: THREE.Vector3; home: THREE.Vector3; state: Flag['state'] }[] = [];
    for (const [team, f] of this.flags) out.push({ team, pos: f.pos, home: f.home, state: f.state });
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
          // Strict-tier roles re-fit the body too — the spawn mix is
          // cosmetic, but a hof in a medium body is a medium standing
          // on a flag, and the sim+silhouette must agree (same table
          // the server roster applies).
          const strict = STRICT_CLASS[role];
          if (strict) this.ctx.bots.find((b) => b.playerId === donor)?.setBotClass(strict);
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
    // The goal point aims at the stand's flag height, not the pedestal's
    // base — the wire bots sense the same lift (serverSenses) so offline/
    // P2P bots press the same spot the networked ones do.
    const enemyStand = enemy.state !== 'carried'
      ? new THREE.Vector3(enemy.pos.x, enemy.pos.y + FLAG_STAND_LIFT, enemy.pos.z)
      : null;
    const pick = roleObjective(role, {
      home: own.home,
      thief,
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: escortPos,
      threat: this.standThreat(own.home, bot.team as string),
      me: { x: bot.position.x, z: bot.position.z },
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
      f.state = 'home'; f.carrier = null; f.pos.copy(f.home); this.seatFlag(f);
    }
  }

  /** Pole seats ON the platform deck when home — pos stays the logical
   *  stand anchor (HUD, grabs), the mesh rides the socket well. */
  private seatFlag(f: Flag): void {
    f.mesh.position.copy(f.pos);
    if (f.state === 'home') f.mesh.position.y += FLAG_STAND_TOP;
  }

  update(dt: number): void {
    this.rebalanceRoles(performance.now());
    for (const [team, f] of this.flags) {
      const px = f.pos.x, py = f.pos.y, pz = f.pos.z;
      if (f.state === 'carried') this.tickCarried(team, f);
      else if (f.state === 'dropped') {
        f.dropT -= dt;
        // Timeout walks itself home — the wire path announces this same
        // transition (dropped→home), so the cue/VFX must fire here too
        // or an offline return is a silent teleport.
        if (f.dropT <= 0) {
          f.state = 'home'; f.pos.copy(f.home);
          this.ctx.onFlagEvent?.('returned', team, f.pos);
        }
      }
      // Touch rules: enemy team grabs it, own team returns a dropped flag.
      if (f.state === 'carried') {
        if (dt > 0) f.vel.set((f.pos.x - px) / dt, (f.pos.y - py) / dt, (f.pos.z - pz) / dt);
        this.seatFlag(f);
        continue;
      }
      this.tickTouch(team, f);
      this.seatFlag(f);
    }
  }

  // Carried flag rides the carrier; scoring the cap requires the carrier's
  // own flag home — the standoff rule that makes flag-defense matter.
  private tickCarried(team: TeamId, f: Flag): void {
    const ctx = this.ctx;
    const cp = f.carrier ? ctx.carrierPos(f.carrier) : null;
    // Carrier vanished without dying (bot prune/disconnect) — death
    // drops funnel through dropCarried, this edge owns its own event.
    if (!cp) {
      f.carrier = null; f.state = 'dropped'; f.dropT = FLAG_RESET_S;
      ctx.onFlagEvent?.('dropped', team, f.pos);
      return;
    }
    f.pos.set(cp.x, cp.y + 1.2, cp.z); // rides above the carrier's head
    const carrierTeam = ctx.teamOf(f.carrier!) as TeamId;
    if (carrierTeam === team) return;
    const ownBase = this.flags.get(carrierTeam)!;
    if (ownBase.state !== 'home' || cp.distanceTo(ownBase.home) >= FLAG_HOME_R) return;
    bank(ctx.scores, carrierTeam);
    ctx.onCapture(carrierTeam);
    ctx.onPersonalPoints?.(f.carrier!, CTF_PTS.cap);
    ctx.onFlagEvent?.('captured', team, f.home);
    ctx.onFeed(`${f.carrier === 'local' ? 'YOU' : f.carrier!.replace('bot:', '')} captured the ${TEAM_LABEL[team]} flag!`);
    if (f.carrier === 'local') sfx.pickup();
    const bot = ctx.bots.find(b => b.playerId === f.carrier);
    if (bot) bot.carryingFlag = false;
    f.carrier = null; f.state = 'home'; f.pos.copy(f.home);
  }

  /** Flag-zone test for the personal-score kill bonus — `pos` inside
   *  radius of EITHER stand (same rule the server applies). */
  nearStand(pos: { x: number; y: number; z: number }, r: number): boolean {
    for (const f of this.flags.values()) {
      const dx = pos.x - f.home.x, dy = pos.y - f.home.y, dz = pos.z - f.home.z;
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
    return false;
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
        ctx.onPersonalPoints?.(id, CTF_PTS.flagReturn);
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
