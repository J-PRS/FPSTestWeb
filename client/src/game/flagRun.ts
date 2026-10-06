/**
 * flagRun — solo flag circuit: a square ring of stands alternating
 * alpha/bravo (opposing corners share a team), each stand home to one
 * flag. Grab any enemy flag, bank it at EITHER friendly stand — the
 * efficient route closes a circuit: grab → cap → next grab is one
 * corner over. Two caps = one lap; the feed keeps lap and best time.
 *
 * Owns its own flag entities rather than driving CtfFlags: the ruleset
 * differs (any-stand cap, no standoff gate, cap returns the enemy flag
 * to ITS home rather than ending a round), so sharing the two-flag
 * class would be an adapter thicker than the code it saves.
 */
import * as THREE from 'three';
import { profOct, mkLoft, mkAnnulus } from '../entities/viewmodel/weaponKit';
import { deckMat, darkMat } from '../structures/structKit';
import { mkFlagMesh } from './ctfFlags.js';
import { TEAM_COLORS, TEAM_LABEL, FLAG_PICKUP_R, FLAG_HOME_R, FLAG_RESET_S,
  bank, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';
import type { Terrain } from '../world/terrain.js';
import type { GameBot } from './botBrain.js';
import { flagReturnFx } from './flagFx.js';
import * as sfx from '../core/sfx.js';
import { Explosion } from '../effects/explosion.js';

const FLAG_BASE_GEO = new THREE.IcosahedronGeometry(0.4, 0);
const RING_SIDE = 800;        // lap square edge — matches the lapMeasure circuit
const LAP_CAPS = 2;           // grab-corner → cap-corner twice = one circuit
// The flag spot is a piece of equipment — the socket the pole inserts
// into — kept flush with the skiing line (no collider: a capper banks
// THROUGH the pad).
const STAND_TOP = 0.46;   // socket mouth — the flag pole inserts here
const STAND_LIFT = 0.6;   // bot aim lift for the socket spot

/** Flag socket — a piece of EQUIPMENT, not a platform: the weighted
 *  octagonal base you slam the pole back into. Low enough to ski
 *  through (no collider): a capper banks THROUGH the pad.
 *  Reads diegetic like T1/T2's: base skirt → socket collar → dark well
 *  the pole actually inserts into. */
export function mkFlagPlate(teamGlow: number): THREE.Group {
  const g = new THREE.Group();
  // Weighted base — a shield-sized socket foot (~1.2m across) that bolts
  // to whatever pad the map gives it; the platform is the MAP's job.
  const base = mkLoft([
    { z: 0.22, ring: profOct(0.9, 0.9, 0.15) },
    { z: 0, ring: profOct(1.2, 1.2, 0.15) },
  ], deckMat);
  base.rotation.x = -Math.PI / 2;
  g.add(base);
  // Socket collar — the raised ring the pole threads into.
  const collar = mkLoft([
    { z: 0.24, ring: profOct(0.62, 0.62, 0.15) },
    { z: 0, ring: profOct(0.78, 0.78, 0.15) },
  ], darkMat);
  collar.rotation.x = -Math.PI / 2;
  collar.position.y = 0.22;
  g.add(collar);
  // Well — recessed dark hole inside the collar.
  const well = mkLoft([
    { z: 0.05, ring: profOct(0.42, 0.42, 0.1) },
    { z: 0, ring: profOct(0.36, 0.36, 0.1) },
  ], darkMat);
  well.rotation.x = -Math.PI / 2;
  well.position.y = 0.42;
  g.add(well);
  // Team-glow rim on the base edge — whose socket this is, at a glance.
  const glow = new THREE.MeshBasicMaterial({ color: teamGlow });
  glow.side = THREE.DoubleSide;
  const rim = mkAnnulus(profOct(1.08, 1.08, 0.15), profOct(0.94, 0.94, 0.15), 0.07, 0.18, glow);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.04;
  g.add(rim);
  return g;
}

export interface FlagRunDeps {
  lazyTerrain(): Terrain;
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyPlayer(): { pos: THREE.Vector3; isDead: boolean; mods: { pickupRadius: number };
    energy?: number; vel?: THREE.Vector3;
    movement?: { setStructures(l: readonly StructureSpec[] | undefined): void } };
  lazyHud(): { updateFlagIndicator(id: string, pos: THREE.Vector3, cam: THREE.Camera, team: string, kind?: 'flag' | 'stand'): void };
  world: { explosions: { push(e: Explosion): void } };
}

interface CircuitFlag {
  mesh: THREE.Group;
  stand: THREE.Group;
  home: THREE.Vector3;
  pos: THREE.Vector3;
  state: 'home' | 'carried' | 'dropped';
  team: TeamId;              // whose flag this is — enemy of the carrier
  carrier: string | null;
  dropT: number;
}

export interface FlagRunWiring {
  playerTeam: TeamId;
  bots: GameBot[];
  teamOf: Map<string, string>;
  scores: TeamScores;
  onFeed(t: string): void;
  onCapture(team: TeamId): void;
  /** Scene-carried flag stand hulls — same bridge CtfBridge uses. */
  applyStandSpecs(specs: StructureSpec[]): void;
}

export class FlagRunBridge {
  private flags: CircuitFlag[] = [];
  private corners: THREE.Vector3[] = [];
  private caps = 0;              // caps this lap
  private lap = 0;
  private lapT = 0;
  private bestLap = Infinity;
  private capT = 0;              // seconds since last cap — leg time
  private playerPos: THREE.Vector3 | null = null;
  // Match stats for the end banner — path meters / live seconds /
  // energy samples taken while alive.
  private pathM = 0;
  private liveS = 0;
  private eSum = 0;
  private eN = 0;
  private maxV = 0;
  private bestCap = Infinity;

  constructor(private deps: FlagRunDeps, private w: FlagRunWiring, around: THREE.Vector3) {
    const terrain = deps.lazyTerrain();
    const half = RING_SIDE / 2;
    // Corners run alpha, bravo, alpha, bravo around the ring so a cap
    // is always one edge away from a grab — the lap emerges from
    // geography, not scripting.
    const raw = [
      { x: around.x - half, z: around.z - half }, { x: around.x + half, z: around.z - half },
      { x: around.x + half, z: around.z + half }, { x: around.x - half, z: around.z + half },
    ];
    raw.forEach((p, i) => {
      const team: TeamId = i % 2 === 0 ? 'alpha' : 'bravo';
      const home = new THREE.Vector3(p.x, terrain.getHeight(p.x, p.z), p.z);
      this.corners.push(home);
      const stand = mkFlagPlate(TEAM_COLORS[team]);
      const base = new THREE.Mesh(FLAG_BASE_GEO,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(1.4) }));
      base.position.y = STAND_TOP + 0.07;
      stand.add(base);
      stand.position.copy(home);
      const mesh = mkFlagMesh(team);
      mesh.position.copy(home);
      mesh.position.y += STAND_TOP;
      deps.lazyScene().add(stand, mesh);
      this.flags.push({ mesh, stand, home, pos: home.clone(), state: 'home', team, carrier: null, dropT: 0 });
    });
    w.onFeed(`FLAG RUN — grab an enemy flag, bank it at any ${TEAM_LABEL[w.playerTeam]} stand.`);
  }

  /** Spawn/respawn anchor — beside the nearest live enemy flag. */
  spawnPoint(): THREE.Vector3 | null {
    const p = this.playerPos;
    if (!p) return this.flags.find(f => f.team !== this.w.playerTeam)?.home ?? null;
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of this.flags) {
      if (f.team === this.w.playerTeam || f.state === 'carried') continue;
      const d = f.home.distanceToSquared(p);
      if (d < bd) { bd = d; best = f.home; }
    }
    return best;
  }

  // Frame-ago toucher positions — same swept-tap convention as CtfBridge.
  private lastTouchPos = new Map<string, THREE.Vector3>();
  // Last measured toucher speed (m/s) — grab/cap feed lines quote it.
  private lastTouchV = new Map<string, number>();

  update(dt: number): void {
    this.lapT += dt;
    this.capT += dt;
    const player = this.deps.lazyPlayer();
    this.playerPos = player.pos;
    const touchers: [string, THREE.Vector3, THREE.Vector3][] = [];
    if (!player.isDead) {
      const prev = this.lastTouchPos.get('local') ?? player.pos;
      this.pathM += player.pos.distanceTo(prev);
      this.liveS += dt;
      this.eSum += player.energy ?? 0;
      this.eN++;
      const v = Math.hypot(player.vel?.x ?? 0, player.vel?.z ?? 0);
      if (v > this.maxV) this.maxV = v;
      this.lastTouchV.set('local', v);
      this.lastTouchPos.set('local', (this.lastTouchPos.get('local') ?? new THREE.Vector3()).copy(player.pos));
      touchers.push(['local', player.pos, prev]);
    }
    for (const b of this.w.bots) {
      if (b.isDead) continue;
      let prev = this.lastTouchPos.get(b.playerId);
      if (!prev) this.lastTouchPos.set(b.playerId, (prev = b.position.clone()));
      this.lastTouchV.set(b.playerId, dt > 0 ? b.position.distanceTo(prev) / dt : 0);
      touchers.push([b.playerId, b.position, prev]);
      prev.copy(b.position);
    }
    // Carried flags ride whatever body holds them — the local player OR
    // a bot capper (?bots=N on flagrun puts rostered cappers on the
    // circuit so a spectator can watch a run).
    const posOf = (id: string): THREE.Vector3 | null =>
      id === 'local' ? player.pos : this.w.bots.find(b => b.playerId === id)?.position ?? null;
    const deadOf = (id: string): boolean =>
      id === 'local' ? player.isDead : this.w.bots.find(b => b.playerId === id)?.isDead ?? true;
    for (const f of this.flags) {
      if (f.state === 'carried') {
        const cPos = f.carrier ? posOf(f.carrier) : null;
        if (cPos && !deadOf(f.carrier!)) {
          f.pos.copy(cPos); f.pos.y += 1.2;
          f.mesh.position.copy(f.pos);
          // Cap: any friendly stand within FLAG_HOME_R banks it.
          const cTeam = this.w.teamOf.get(f.carrier!) as TeamId | undefined;
          for (const home of this.friendlyHomes(cTeam ?? this.w.playerTeam)) {
            if (f.pos.distanceTo(home) >= FLAG_HOME_R + STAND_TOP) continue;
            this.cap(f);
            break;
          }
        } else {
          this.setBotCarry(f.carrier, false);
          f.state = 'dropped'; f.carrier = null;
          f.pos.y = this.deps.lazyTerrain().getHeight(f.pos.x, f.pos.z);
          f.dropT = FLAG_RESET_S;
          this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
        }
        continue;
      }
      if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) this.sendHome(f, 'returned');
      }
      // home/dropped both accept touches — swept capsule like CtfFlags.
      for (const [id, tp, pp] of touchers) {
        const tTeam = this.w.teamOf.get(id);
        if (f.state === 'dropped' && tTeam === f.team) { this.sendHome(f, 'returned'); break; }
        if (tTeam === f.team) continue;
        const segLen2 = pp.distanceToSquared(tp);
        const t = segLen2 > 0 ? Math.min(1, Math.max(0,
          ((f.pos.x - pp.x) * (tp.x - pp.x) + (f.pos.y - pp.y) * (tp.y - pp.y) + (f.pos.z - pp.z) * (tp.z - pp.z)) / segLen2)) : 0;
        const dx = pp.x + (tp.x - pp.x) * t - f.pos.x;
        const dy = pp.y + (tp.y - pp.y) * t - f.pos.y;
        const dz = pp.z + (tp.z - pp.z) * t - f.pos.z;
        // Server touch rule: |dy|<=6 vertical + planar radius — the deck
        // puts the flag ~3m over your feet, a 3D sphere would miss.
        const pickupR = FLAG_PICKUP_R * (id === 'local' ? (player.mods.pickupRadius ?? 1) : 1);
        if (Math.abs(dy) > 6 || dx * dx + dz * dz > pickupR * pickupR) continue;
        f.state = 'carried'; f.carrier = id;
        this.setBotCarry(id, true);
        this.burst(f.pos, f.team, 1.4);
        sfx.flagCue('taken', false);
        const gv = (this.lastTouchV.get(id) ?? 0).toFixed(0);
        this.w.onFeed(id === 'local' ? `YOU took the ${TEAM_LABEL[f.team]} flag @ ${gv} m/s!`
          : `${id.replace('bot:', '')} took the ${TEAM_LABEL[f.team]} flag @ ${gv} m/s!`);
        break;
      }
      f.mesh.position.copy(f.pos);
      if (f.state === 'home') f.mesh.position.y += STAND_TOP;
    }
    // Markers: one pin per stand, lifted to deck height.
    const cam = this.deps.lazyCamera();
    const hud = this.deps.lazyHud();
    for (const f of this.flags) {
      const lift = f.state === 'home' ? STAND_TOP : 0;
      f.pos.y += 3.4 + lift;
      hud.updateFlagIndicator(`fr:${f.home.x}:${f.home.z}`, f.pos, cam, f.team);
      f.pos.y -= 3.4 + lift;
      f.home.y += STAND_TOP + 0.07;
      hud.updateFlagIndicator(`frs:${f.home.x}:${f.home.z}`, f.home, cam, f.team, 'stand');
      f.home.y -= STAND_TOP + 0.07;
    }
  }

  /** End-of-match stat line appended to the win banner. */
  statsLine(): string {
    const speed = this.liveS > 0 ? this.pathM / this.liveS : 0;
    const e = this.eN > 0 ? this.eSum / this.eN : 0;
    const leg = this.bestCap === Infinity ? null : `, best leg ${this.bestCap.toFixed(1)}s`;
    const lap = this.bestLap === Infinity ? null : `, best lap ${this.bestLap.toFixed(1)}s`;
    return ` — ${this.lap} laps, avg ${speed.toFixed(1)} / max ${this.maxV.toFixed(1)} m/s, avg E ${e.toFixed(0)}${leg ?? ''}${lap ?? ''}`;
  }

  private friendlyHomes(team: TeamId): THREE.Vector3[] {
    return this.flags.filter(f => f.team === team).map(f => f.home);
  }

  private setBotCarry(id: string | null, v: boolean): void {
    const b = id ? this.w.bots.find(x => x.playerId === id) : undefined;
    if (b) b.carryingFlag = v;
  }

  /** Bot objective for flagrun — grab the nearest enemy flag, bank it at
   *  the nearest friendly stand. Same shape CtfBridge feeds brains. */
  objectiveInfoFor(bot: GameBot): { pos: THREE.Vector3; infiltrating: boolean;
    running?: boolean; thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } } | null {
    const myTeam: TeamId = bot.team === 'bravo' ? 'bravo' : 'alpha';
    if (bot.carryingFlag) {
      let home: THREE.Vector3 | null = null, hd = Infinity;
      for (const f of this.flags) {
        if (f.team !== myTeam) continue;
        const d = f.home.distanceToSquared(bot.position);
        if (d < hd) { hd = d; home = f.home; }
      }
      return home ? { pos: home.clone(), infiltrating: false, running: true } : null;
    }
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of this.flags) {
      if (f.team === myTeam || f.state === 'carried') continue;
      const d = f.pos.distanceToSquared(bot.position);
      if (d < bd) { bd = d; best = f.pos; }
    }
    return best
      ? { pos: new THREE.Vector3(best.x, best.y + STAND_LIFT, best.z), infiltrating: true }
      : null;
  }

  private cap(f: CircuitFlag): void {
    this.caps++;
    const cTeam = (f.carrier ? this.w.teamOf.get(f.carrier) : null) as TeamId | null ?? this.w.playerTeam;
    this.setBotCarry(f.carrier, false);
    bank(this.w.scores, cTeam);
    this.w.onCapture(cTeam);
    const cv = (f.carrier ? this.lastTouchV.get(f.carrier) ?? 0 : 0).toFixed(0);
    this.w.onFeed(`CAP ${this.caps % LAP_CAPS || LAP_CAPS}/${LAP_CAPS} — ${this.capT.toFixed(1)}s @ ${cv} m/s`);
    if (this.capT < this.bestCap) this.bestCap = this.capT;
    sfx.flagCue('captured', true);
    this.burst(f.home, cTeam, 2.4);
    if (this.caps % LAP_CAPS === 0) {
      this.lap++;
      if (this.lapT < this.bestLap) this.bestLap = this.lapT;
      this.w.onFeed(`LAP ${this.lap} — ${this.lapT.toFixed(1)}s  (best ${this.bestLap.toFixed(1)}s)`);
      this.lapT = 0;
    }
    this.capT = 0;
    this.sendHome(f, 'captured');
  }

  private sendHome(f: CircuitFlag, kind: 'returned' | 'captured'): void {
    f.state = 'home'; f.carrier = null; f.pos.copy(f.home);
    if (kind === 'returned') { sfx.flagCue('returned', f.team === this.w.playerTeam); flagReturnFx(f.pos, f.team, null); }
    this.burst(f.pos, f.team, kind === 'captured' ? 2.4 : 1.4);
  }

  private burst(at: THREE.Vector3, team: TeamId, power: number): void {
    this.deps.world.explosions.push(new Explosion(
      this.deps.lazyScene(), new THREE.Vector3(at.x, at.y + 1.2, at.z), false, 0,
      this.deps.lazyTerrain(), power, TEAM_COLORS[team]));
  }

  reset(): void {
    for (const f of this.flags) { f.state = 'home'; f.carrier = null; f.pos.copy(f.home); }
    this.caps = 0; this.lap = 0; this.lapT = 0; this.capT = 0;
    this.pathM = 0; this.liveS = 0; this.eSum = 0; this.eN = 0;
    this.maxV = 0; this.bestCap = Infinity; this.bestLap = Infinity;
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const f of this.flags) {
      if (f.carrier !== carrierId) continue;
      this.setBotCarry(carrierId, false);
      f.carrier = null; f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.deps.lazyTerrain().getHeight(at.x, at.z);
      f.dropT = FLAG_RESET_S;
      this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
    }
  }
}
