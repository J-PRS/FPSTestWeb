import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { TEAM_COLORS, TEAM_LABEL, FLAG_HOME_R, FLAG_RESET_S, CTF_PTS, bank, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { GameBot } from './bots/botBrain.js';
import { roleObjective, roleSide, ROLE_PRIORITY, STRICT_CLASS, misfitClass, type BotRole } from '../../../shared/flagGoals.js';
import * as sfx from '../core/sfx.js';
import { mkFlagStand, FLAG_STAND_TOP } from '../structures/structures.js';
import { wornMetalMat } from '../entities/procMetal.js';
import { GRAVITY } from '../core/config.js';
import { FLAG_STAND_LIFT, type StructureSpec } from '../../../shared/mapSpec.js';
import { KIT_HULLS, KIT_STAND_TOP } from '../../../shared/structKits.js';

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
  /** Loose-flag ballistic velocity (RoomFlags.vel parity) — nonzero
   *  means the flag is tumbling, not resting. */
  flyVel: THREE.Vector3;
  /** Whose toss is still airborne — the thrower can't instantly
   *  re-grab their own throw, same guard the server applies. */
  airborneBy: string | null;
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
  onFlagEvent?(kind: 'taken' | 'dropped' | 'returned' | 'captured', team: TeamId, at: THREE.Vector3, actor?: { id: string; team: string | undefined }): void;
  /** Personal-score payout — mirrors the server's CTF_PTS awards so the
   *  offline board's PTS column credits objective work too. */
  onPersonalPoints?(id: string, pts: number): void;
}

const FLAG_POLE_GEO = new THREE.CylinderGeometry(0.06, 0.08, 4, 6);
const FLAG_POLE_MAT = wornMetalMat(0x4A_4E_55); // gunmetal — the standard is equipment, not plastic
/** Banner cloth — hangs DOWN from the crossbar like a war standard
 *  (T:A flags are banners, not pennants): a vertical plane pre-rippled
 *  once at build, flat at the bar line, waving at the free bottom. */
const FLAG_BANNER_GEO = ((): THREE.PlaneGeometry => {
  const geo = new THREE.PlaneGeometry(1.5, 1.9, 6, 8);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = (0.95 - y) / 1.9; // bar line -> free hem
    // Outward-only wave: the pole passes BETWEEN the two panels, so a
    // ripple that dips inward grazes the shaft. abs() keeps the bulge
    // strictly away from the pole on both sides (the right panel is
    // this same geometry mirrored).
    pos.setZ(i, Math.abs(Math.sin(y * 2.6 + x * 3)) * 0.13 * u);
  }
  geo.computeVertexNormals();
  return geo;
})();
const FLAG_BAR_GEO = new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6);
const FLAG_POMMEL_GEO = new THREE.CylinderGeometry(0.02, 0.11, 0.5, 8);
const FLAG_BASE_GEO = new THREE.IcosahedronGeometry(0.4, 0);
const FLAG_FINIAL_GEO = new THREE.IcosahedronGeometry(0.14, 0);

/** The movable piece — pole + banner + finial, group origin at the
 *  flag's logical pos (flagRun + ctfFlags share the same look). */
export function mkFlagMesh(team: TeamId, color = TEAM_COLORS[team]): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(FLAG_POLE_GEO, FLAG_POLE_MAT);
  pole.position.y = 2;
  // Crossbar the banner hangs from — a standard, not a pennant.
  const bar = new THREE.Mesh(FLAG_BAR_GEO, FLAG_POLE_MAT);
  bar.rotation.z = Math.PI / 2;
  bar.position.y = 3.8;
  const bannerMat = new THREE.MeshBasicMaterial({ color });
  bannerMat.side = THREE.DoubleSide; // cloth reads from either face
  // The cloth splits into two panels so the pole passes BETWEEN them —
  // one banner read from either side, no clipping through the shaft.
  const bannerL = new THREE.Mesh(FLAG_BANNER_GEO, bannerMat);
  bannerL.position.set(0, 2.85, 0.11);
  const bannerR = new THREE.Mesh(FLAG_BANNER_GEO, bannerMat);
  bannerR.rotation.y = Math.PI; // mirror so its wave also bulges outward
  bannerR.position.set(0, 2.85, -0.11);
  const finial = new THREE.Mesh(FLAG_FINIAL_GEO,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.4) }));
  finial.position.y = 4.15;
  // Pommel — a tapered butt cap terminates the pole; reads as the
  // spear point the socket swallows when the flag seats.
  const pommel = new THREE.Mesh(FLAG_POMMEL_GEO, FLAG_POLE_MAT);
  pommel.rotation.x = Math.PI; // taper points DOWN
  pommel.position.y = -0.2;
  g.add(pole, bar, bannerL, bannerR, finial, pommel);
  return g;
}

/** Room.flagStandTop's offline twin: a spec base rides the walkable
 *  surface under it — terrain or a stand-capable kit piece's deck
 *  (KIT_STAND_TOP), whichever is higher. Without this an authored base
 *  y is honored verbatim and the flag homes INSIDE its own stand. */
/** A kit piece's deck height where a base lands inside its hull
 *  footprint; undefined when it doesn't host the point. */
function kitDeckAt(base: { x: number; z: number }, s: StructureSpec): number | undefined {
  const lift = KIT_STAND_TOP[s.piece ?? ''];
  if (lift === undefined) { return undefined; }
  const k = s.scale ?? 1;
  let reach = 0;
  for (const h of KIT_HULLS[s.piece ?? ''] ?? []) {
    reach = Math.max(reach,
      (Math.abs(h.pos.x) + h.size.x / 2) * k,
      (Math.abs(h.pos.z) + h.size.z / 2) * k);
  }
  return Math.abs(base.x - s.pos.x) <= reach && Math.abs(base.z - s.pos.z) <= reach
    ? s.pos.y + lift * k : undefined;
}

function standTopAt(base: { x: number; y: number; z: number }, structures: readonly StructureSpec[] | undefined, terrain: { getHeight(x: number, z: number): number }): number {
  let top = Math.max(base.y, terrain.getHeight(base.x, base.z));
  for (const s of structures ?? []) {
    if (s.kind === 'kit') {
      const deck = kitDeckAt(base, s);
      if (deck !== undefined) { top = Math.max(top, deck); }
      continue;
    }
    if (s.size !== undefined && Math.abs(base.x - s.pos.x) <= s.size.x / 2 && Math.abs(base.z - s.pos.z) <= s.size.z / 2) {
      top = Math.max(top, s.pos.y + s.size.y);
    }
  }
  return top;
}

/**
 * CTF flag entities — a pole + banner at each base, carried above a head,
 * dropped on death, returned on own-team touch. All mode rules live here;
 * TeamBots only bridges it to the roster/score.
 */
export class CtfFlags {
  private flags: Map<TeamId, Flag> = new Map();

  constructor(private ctx: FlagCtx, around: THREE.Vector3,
    bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } },
    structures?: readonly StructureSpec[]) {
    // Authored spec bases win; else stands sit on the X axis around the
    // player spawn — readable landmarks on a spec-less field.
    const terrain = ctx.lazyTerrain();
    for (const team of ['alpha', 'bravo'] as TeamId[]) {
      const spec = bases?.[team];
      const sign = team === 'alpha' ? -1 : 1;
      const home = spec ? new THREE.Vector3(spec.x, 0, spec.z)
        : new THREE.Vector3(around.x + sign * 70, 0, around.z);
      home.y = spec ? standTopAt(spec, structures, terrain) : terrain.getHeight(home.x, home.z);
      // Stand (bare gem socket) is planted once at home and never moves;
      // the flag (pole + banner + finial) is the ripped-out piece —
      // home reseats the pole in the socket so the pair reads as one flag.
      const stand = mkFlagStand(TEAM_COLORS[team]);
      const base = new THREE.Mesh(FLAG_BASE_GEO,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(1.4) }));
      base.position.y = FLAG_STAND_TOP + 0.07; // gem in the socket well
      stand.add(base);
      stand.position.copy(home);
      const g = mkFlagMesh(team);
      g.position.copy(home);
      g.position.y += FLAG_STAND_TOP; // pole seats on the platform deck
      ctx.lazyScene().add(stand, g);
      this.flags.set(team, { mesh: g, stand, home, pos: home.clone(), state: 'home', carrier: null, dropT: 0, vel: new THREE.Vector3(), flyVel: new THREE.Vector3(), airborneBy: null });
    }
  }

  /** Scene teardown — retireOfflineBots drops TeamBots wholesale, and a
   *  leaked stand+flag pair reads as a wire flag with no HUD marker. */
  dispose(): void {
    const scene = this.ctx.lazyScene();
    for (const f of this.flags.values()) { scene.remove(f.mesh, f.stand); }
    this.flags.clear();
  }

  /** Flag + stand positions for the HUD markers — DOM overlay, reads
   *  every frame. `pos` is the flag (diamond); `home` is the stand
   *  (hollow socket). They coincide while the flag is home. */
  markers(): { team: TeamId; pos: THREE.Vector3; home: THREE.Vector3; state: Flag['state'] }[] {
    const out: { team: TeamId; pos: THREE.Vector3; home: THREE.Vector3; state: Flag['state'] }[] = [];
    for (const [team, f] of this.flags) { out.push({ team, pos: f.pos, home: f.home, state: f.state }); }
    return out;
  }

  // Offline roles — the same shared/flagGoals.ts table ServerBots uses,
  // minus technician (no deploy kit locally). Infiltrator IS supported:
  // the cloak intent rides GameBot.applyStatus like anywhere else.
  // Without roles every bot read the same objective and the whole squad
  // ran the same flag route — nobody held the stand.
  private roles = new Map<string, 'capper' | 'ldefense' | 'hof' | 'offense' | 'defense' | 'infiltrator'>();

  /** Jersey swap — a rekeyed capper keeps its slot; without this the
   *  next cycle reads it as unassigned and re-rolls a generic role. */
  rekey(oldId: string, newId: string): void {
    const r = this.roles.get(oldId);
    this.roles.delete(oldId);
    if (r !== undefined) { this.roles.set(newId, r); }
  }
  private roleT = 0;
  // Offline bots DO carry the cloak intent (GameBot.applyStatus →
  // STATUS.CLOAK → setCloakHidden), so the infiltrator lane is playable
  // locally too — technician alone stays server-only (no deploy kit).
  private static readonly SUPPORTED = new Set(['capper', 'ldefense', 'hof', 'infiltrator']);

  private rebalanceRoles(now: number): void {
    if (now < this.roleT) { return; }
    this.roleT = now + 5000;
    const byTeam = new Map<TeamId, string[]>();
    for (const b of this.ctx.bots) {
      const t = b.team as TeamId;
      if (t !== 'alpha' && t !== 'bravo') { continue; }
      let list = byTeam.get(t);
      if (!list) { list = []; byTeam.set(t, list); }
      list.push(b.playerId);
    }
    const WANT = ROLE_PRIORITY.filter((w): boolean => CtfFlags.SUPPORTED.has(w.role));
    for (const ids of byTeam.values()) { this.assignTeamRoles(ids, WANT); }
  }

  /** One team's roster pass — carriers are off the donor market, then
   *  specialists pull from the generic pool and the remainder splits
   *  offense/defense by parity. */
  private assignTeamRoles(ids: string[], WANT: typeof ROLE_PRIORITY): void {
    const free = ids.filter((id): boolean => {
      for (const f of this.flags.values()) { if (f.carrier === id) { return false; } }
      return true;
    });
    // Specialists are sticky: donors only come from the generic pool
    // (offense/defense), and a body is consumed once per cycle.
    const isSpecial = (id: string): boolean => WANT.some((w): boolean => this.roles.get(id) === w.role);
    const donors = free.filter((id): boolean => !isSpecial(id));
    for (const { role, want, minSquad } of WANT) {
      if (ids.length < minSquad) { break; }
      this.fillRole(ids, role, want, donors);
    }
    // Everyone not assigned a specialist slot is offense/defense by
    // squad parity — the home side never empties completely.
    let d = 0;
    for (const id of free) {
      if (!this.roles.has(id)) { this.roles.set(id, (d += 1) % 2 === 1 ? 'offense' : 'defense'); }
    }
  }

  /** Pull `want` donors into a specialist role; strict-tier roles also
   *  re-fit the body — a hof in a medium body is a medium standing on a
   *  flag, and the sim+silhouette must agree (server roster's table). */
  private fillRole(ids: string[], role: BotRole, want: number, donors: string[]): void {
    let have = ids.filter((id): boolean => this.roles.get(id) === role).length;
    while (have < want) {
      const donor = donors.shift();
      if (!donor) { break; }
      this.roles.set(donor, role as 'capper' | 'ldefense' | 'hof' | 'infiltrator');
      const strict = STRICT_CLASS[role];
      // Rare misfit body on purpose — heavy capper / light HoF comedy.
      if (strict) { this.ctx.bots.find((b): boolean => b.playerId === donor)?.setBotClass(misfitClass(strict, Math.random)); }
      have += 1;
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
    if (!enemy || !own) { return null; }
    if (bot.carryingFlag) { return { pos: own.home.clone(), infiltrating: false, running: true }; }
    const role = this.roles.get(bot.playerId) ?? 'offense';
    const thief = own.state === 'carried' && own.carrier ? this.ctx.carrierPos(own.carrier) : null;
    const escortPos = enemy.carrier ? this.ctx.carrierPos(enemy.carrier) : null;
    // The goal point aims at the stand's flag height, not the pedestal's
    // base — the wire bots sense the same lift (serverSenses) so offline/
    // P2P bots press the same spot the networked ones do.
    const enemyStand = enemy.state === 'carried'
      ? null
      : new THREE.Vector3(enemy.pos.x, enemy.pos.y + FLAG_STAND_LIFT, enemy.pos.z);
    const pick = roleObjective(role, {
      home: own.home,
      thief,
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: escortPos,
      threat: this.standThreat(own.home, bot.team as string),
      me: { x: bot.position.x, z: bot.position.z },
    }, bot.dutyLevel, roleSide(bot.playerId));
    // Cloak intent is the infiltrator's alone — the drain is
    // speed-scaled, so a sprinting capper would arrive tank-dry.
    const infiltrating = enemyStand !== null && pick === enemyStand && role === 'infiltrator';
    return {
      pos: new THREE.Vector3(pick.x, pick.y, pick.z), infiltrating,
      // Only roles whose goal IS the thief get the beacon — a capper
      // escorting doesn't break off to chase.
      thief: CtfFlags.thiefBeacon(thief, pick, own),
    };
  }

  /** Closest hostile inside the home ring — the HoF's body-block
   *  anchor. touchers() includes the local player, so a human pressing
   *  the stand draws the lean too. */
  private standThreat(home: THREE.Vector3, myTeam: string): { x: number; y: number; z: number } | null {
    let best: THREE.Vector3 | null = null, bestD = 45;
    for (const [id, pos] of this.ctx.touchers()) {
      if (this.ctx.teamOf(id) === myTeam) { continue; }
      const d = Math.hypot(pos.x - home.x, pos.z - home.z);
      if (d < bestD) { bestD = d; best = pos; }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  private static thiefBeacon(thief: THREE.Vector3 | null, pick: { x: number; y: number; z: number }, own: Flag): { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } | undefined {
    return thief !== null && pick === thief && own.carrier
      ? { id: own.carrier, pos: thief, vel: own.vel } : undefined;
  }

  /** Local G-press flag toss — the same claim RoomFlags.throwFor
   *  resolves online: FULL carrier speed inherited, deliberate lob
   *  along aim. Same constants both ends so the offline arc reads
   *  identical to the wire replay. */
  throwLocal(carrierId: string, pos: THREE.Vector3, vel: THREE.Vector3,
    yaw: number, pitch: number): void {
    for (const [team, f] of this.flags) {
      if (f.carrier !== carrierId) { continue; }
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      f.carrier = null;
      f.state = 'dropped';
      f.pos.copy(pos);
      f.flyVel.set(
        vel.x + cp * Math.sin(yaw) * 20,
        vel.y + 3 + sp * 20,
        vel.z + cp * Math.cos(yaw) * 20);
      f.airborneBy = carrierId;
      f.dropT = FLAG_RESET_S;
      const bot = this.ctx.bots.find((b): boolean => b.playerId === carrierId);
      if (bot) { bot.carryingFlag = false; }
      this.ctx.onFlagEvent?.('dropped', team, f.pos, { id: carrierId, team: this.ctx.teamOf(carrierId) });
    }
  }

  /** Loose-flag tumble — mirrors RoomFlags.tickBallistic (world
   *  gravity, 0.3 bounce, 4/s skid bleed, 0.6 settle). */
  private tickBallistic(f: Flag, dt: number): void {
    if (f.flyVel.x === 0 && f.flyVel.y === 0 && f.flyVel.z === 0) { return; }
    f.flyVel.y += GRAVITY * dt;
    f.pos.addScaledVector(f.flyVel, dt);
    const gy = this.ctx.lazyTerrain().getHeight(f.pos.x, f.pos.z) + 0.5;
    if (f.pos.y <= gy) {
      f.pos.y = gy;
      f.flyVel.y = f.flyVel.y < -2 ? -f.flyVel.y * 0.3 : 0;
      const bleed = Math.max(0, 1 - 4 * dt);
      f.flyVel.x *= bleed;
      f.flyVel.z *= bleed;
    }
    if (f.flyVel.lengthSq() < 0.36 && f.pos.y <= gy + 0.05) {
      f.flyVel.set(0, 0, 0);
      f.airborneBy = null; // settled — the thrower may grab it again
    }
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const [team, f] of this.flags) {
      if (f.carrier !== carrierId) { continue; }
      f.carrier = null;
      f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.ctx.lazyTerrain().getHeight(at.x, at.z);
      f.flyVel.set(0, 0, 0); f.airborneBy = null;
      f.dropT = FLAG_RESET_S;
      const bot = this.ctx.bots.find((b): boolean => b.playerId === carrierId);
      if (bot) { bot.carryingFlag = false; }
      this.ctx.onFlagEvent?.('dropped', team, f.pos, { id: carrierId, team: this.ctx.teamOf(carrierId) });
    }
  }

  /** Match reset — every flag home, nobody carrying. */
  reset(): void {
    for (const f of this.flags.values()) {
      f.state = 'home'; f.carrier = null; f.pos.copy(f.home);
      f.flyVel.set(0, 0, 0); f.airborneBy = null; CtfFlags.seatFlag(f);
    }
  }

  /** Pole seats ON the platform deck when home — pos stays the logical
   *  stand anchor (HUD, grabs), the mesh rides the socket well. */
  private static seatFlag(f: Flag): void {
    f.mesh.position.copy(f.pos);
    if (f.state === 'home') { f.mesh.position.y += FLAG_STAND_TOP; }
  }

  update(dt: number): void {
    this.rebalanceRoles(performance.now());
    for (const [team, f] of this.flags) {
      const px = f.pos.x, py = f.pos.y, pz = f.pos.z;
      if (f.state === 'carried') { this.tickCarried(team, f); }
      else if (f.state === 'dropped') {
        this.tickBallistic(f, dt);
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
        if (dt > 0) { f.vel.set((f.pos.x - px) / dt, (f.pos.y - py) / dt, (f.pos.z - pz) / dt); }
        CtfFlags.seatFlag(f);
        continue;
      }
      this.tickTouch(team, f);
      CtfFlags.seatFlag(f);
    }
  }

  // Carried flag rides the carrier; scoring the cap requires the carrier's
  // own flag home — the standoff rule that makes flag-defense matter.
  private tickCarried(team: TeamId, f: Flag): void {
    const { ctx } = this;
    const { carrier } = f;
    const cp = carrier ? ctx.carrierPos(carrier) : null;
    // Carrier vanished without dying (bot prune/disconnect) — death
    // drops funnel through dropCarried, this edge owns its own event.
    if (!cp || !carrier) {
      const vanished = carrier ?? '?';
      f.carrier = null; f.state = 'dropped'; f.dropT = FLAG_RESET_S;
      f.flyVel.set(0, 3, 0); // same tumble pop RoomFlags.loose gives
      ctx.onFlagEvent?.('dropped', team, f.pos, { id: vanished, team: ctx.teamOf(vanished) });
      return;
    }
    f.pos.set(cp.x, cp.y + 1.2, cp.z); // rides above the carrier's head
    const carrierTeam = ctx.teamOf(carrier) as TeamId;
    if (carrierTeam === team) { return; }
    const ownBase = this.flags.get(carrierTeam);
    if (!ownBase) { return; }
    if (ownBase.state !== 'home' || cp.distanceTo(ownBase.home) >= FLAG_HOME_R) { return; }
    bank(ctx.scores, carrierTeam);
    ctx.onCapture(carrierTeam);
    ctx.onPersonalPoints?.(carrier, CTF_PTS.cap);
    ctx.onFlagEvent?.('captured', team, f.home, { id: carrier, team: carrierTeam });
    ctx.onFeed(`${carrier === 'local' ? 'YOU' : carrier.replace('bot:', '')} captured the ${TEAM_LABEL[team]} flag!`);
    if (carrier === 'local') { sfx.pickup(); }
    const bot = ctx.bots.find((b): boolean => b.playerId === carrier);
    if (bot) { bot.carryingFlag = false; }
    f.carrier = null; f.state = 'home'; f.pos.copy(f.home);
    f.flyVel.set(0, 0, 0); f.airborneBy = null;
  }

  /** Flag-zone test for the personal-score kill bonus — `pos` inside
   *  radius of EITHER stand (same rule the server applies). */
  nearStand(pos: { x: number; y: number; z: number }, r: number): boolean {
    for (const f of this.flags.values()) {
      const dx = pos.x - f.home.x, dy = pos.y - f.home.y, dz = pos.z - f.home.z;
      if (dx * dx + dy * dy + dz * dz <= r * r) { return true; }
    }
    return false;
  }

  /** Swept grab reach: closest point on the toucher's frame travel
   *  (prev→cur) to the flag, so a 60m/s fly-by can't tunnel between
   *  samples. Returns the squared distance at closest approach. */
  private static sweepDist2(f: Flag, tp: THREE.Vector3, pp: THREE.Vector3): number {
    const segLen2 = pp.distanceToSquared(tp);
    const t = segLen2 > 0
      ? Math.min(1, Math.max(0,
          ((f.pos.x - pp.x) * (tp.x - pp.x) + (f.pos.y - pp.y) * (tp.y - pp.y) + (f.pos.z - pp.z) * (tp.z - pp.z)) / segLen2))
      : 0;
    const dx = pp.x + (tp.x - pp.x) * t - f.pos.x;
    const dy = pp.y + (tp.y - pp.y) * t - f.pos.y;
    const dz = pp.z + (tp.z - pp.z) * t - f.pos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  private tickTouch(team: TeamId, f: Flag): void {
    const { ctx } = this;
    for (const [id, tp, pp] of ctx.touchers()) {
      if (id === f.airborneBy) { continue; } // thrower can't re-grab mid-flight
      const tTeam = ctx.teamOf(id);
      if (CtfFlags.sweepDist2(f, tp, pp) > this.ctx.pickupRadiusOf(id) ** 2) { continue; }
      if (f.state === 'dropped' && tTeam === team) {
        f.state = 'home'; f.pos.copy(f.home); // returned on touch
        f.flyVel.set(0, 0, 0); f.airborneBy = null;
        ctx.onPersonalPoints?.(id, CTF_PTS.flagReturn);
        ctx.onFlagEvent?.('returned', team, f.pos, { id, team: tTeam });
        return;
      }
      if (tTeam === team) { continue; }
      ctx.onFlagEvent?.('taken', team, f.pos, { id, team: tTeam });
      f.state = 'carried'; f.carrier = id;
      f.flyVel.set(0, 0, 0); f.airborneBy = null;
      const bot = ctx.bots.find((b): boolean => b.playerId === id);
      if (bot) { bot.carryingFlag = true; }
      ctx.onFeed(`${id === 'local' ? 'YOU' : id.replace('bot:', '')} took the ${TEAM_LABEL[team]} flag!`);
      return;
    }
  }
}
