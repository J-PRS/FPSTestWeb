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
import { mkFlagStand, FLAG_STAND_TOP } from '../structures/structures.js';
import { flagStandSpecs } from '../../../shared/mapSpec.js';
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

export interface FlagRunDeps {
  lazyTerrain(): Terrain;
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyPlayer(): { pos: THREE.Vector3; isDead: boolean; mods: { pickupRadius: number };
    energy?: number;
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
    const specs: StructureSpec[] = [];
    raw.forEach((p, i) => {
      const team: TeamId = i % 2 === 0 ? 'alpha' : 'bravo';
      const home = new THREE.Vector3(p.x, terrain.getHeight(p.x, p.z), p.z);
      this.corners.push(home);
      specs.push(...flagStandSpecs(home, team));
      const stand = mkFlagStand(TEAM_COLORS[team]);
      const base = new THREE.Mesh(FLAG_BASE_GEO,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(1.4) }));
      base.position.y = FLAG_STAND_TOP + 0.07;
      stand.add(base);
      stand.position.copy(home);
      const mesh = mkFlagMesh(team);
      mesh.position.copy(home);
      mesh.position.y += FLAG_STAND_TOP;
      deps.lazyScene().add(stand, mesh);
      this.flags.push({ mesh, stand, home, pos: home.clone(), state: 'home', team, carrier: null, dropT: 0 });
    });
    w.applyStandSpecs(specs);
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
      this.lastTouchPos.set('local', (this.lastTouchPos.get('local') ?? new THREE.Vector3()).copy(player.pos));
      touchers.push(['local', player.pos, prev]);
    }
    for (const b of this.w.bots) {
      if (b.isDead) continue;
      let prev = this.lastTouchPos.get(b.playerId);
      if (!prev) this.lastTouchPos.set(b.playerId, (prev = b.position.clone()));
      touchers.push([b.playerId, b.position, prev]);
      prev.copy(b.position);
    }
    for (const f of this.flags) {
      if (f.state === 'carried') {
        // Only the local player carries in flagrun — ride his body.
        f.pos.copy(player.pos); f.pos.y += 1.2;
        f.mesh.position.copy(f.pos);
        if (player.isDead) {
          f.state = 'dropped'; f.carrier = null;
          f.pos.y = this.deps.lazyTerrain().getHeight(f.pos.x, f.pos.z);
          f.dropT = FLAG_RESET_S;
          this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
        } else {
          // Cap: any friendly stand within FLAG_HOME_R banks it.
          for (const home of this.friendlyHomes()) {
            if (f.pos.distanceTo(home) >= FLAG_HOME_R + FLAG_STAND_TOP) continue;
            this.cap(f);
            break;
          }
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
        if (tTeam === f.team || id !== 'local') continue;
        const segLen2 = pp.distanceToSquared(tp);
        const t = segLen2 > 0 ? Math.min(1, Math.max(0,
          ((f.pos.x - pp.x) * (tp.x - pp.x) + (f.pos.y - pp.y) * (tp.y - pp.y) + (f.pos.z - pp.z) * (tp.z - pp.z)) / segLen2)) : 0;
        const dx = pp.x + (tp.x - pp.x) * t - f.pos.x;
        const dy = pp.y + (tp.y - pp.y) * t - f.pos.y;
        const dz = pp.z + (tp.z - pp.z) * t - f.pos.z;
        // Server touch rule: |dy|<=6 vertical + planar radius — the deck
        // puts the flag ~3m over your feet, a 3D sphere would miss.
        if (Math.abs(dy) > 6 || dx * dx + dz * dz > (FLAG_PICKUP_R * (player.mods.pickupRadius ?? 1)) ** 2) continue;
        f.state = 'carried'; f.carrier = id;
        this.burst(f.pos, f.team, 1.4);
        sfx.flagCue('taken', false);
        this.w.onFeed(`YOU took the ${TEAM_LABEL[f.team]} flag!`);
        break;
      }
      f.mesh.position.copy(f.pos);
      if (f.state === 'home') f.mesh.position.y += FLAG_STAND_TOP;
    }
    // Markers: one pin per stand, lifted to deck height.
    const cam = this.deps.lazyCamera();
    const hud = this.deps.lazyHud();
    for (const f of this.flags) {
      const lift = f.state === 'home' ? FLAG_STAND_TOP : 0;
      f.pos.y += 3.4 + lift;
      hud.updateFlagIndicator(`fr:${f.home.x}:${f.home.z}`, f.pos, cam, f.team);
      f.pos.y -= 3.4 + lift;
      f.home.y += FLAG_STAND_TOP + 0.07;
      hud.updateFlagIndicator(`frs:${f.home.x}:${f.home.z}`, f.home, cam, f.team, 'stand');
      f.home.y -= FLAG_STAND_TOP + 0.07;
    }
  }

  /** End-of-match stat line appended to the win banner. */
  statsLine(): string {
    const speed = this.liveS > 0 ? this.pathM / this.liveS : 0;
    const e = this.eN > 0 ? this.eSum / this.eN : 0;
    return ` — ${this.lap} laps, avg ${speed.toFixed(1)} m/s, avg E ${e.toFixed(0)}`;
  }

  private friendlyHomes(): THREE.Vector3[] {
    return this.flags.filter(f => f.team === this.w.playerTeam).map(f => f.home);
  }

  private cap(f: CircuitFlag): void {
    this.caps++;
    bank(this.w.scores, this.w.playerTeam);
    this.w.onCapture(this.w.playerTeam);
    this.w.onFeed(`CAP ${this.caps % LAP_CAPS || LAP_CAPS}/${LAP_CAPS} — ${this.capT.toFixed(1)}s`);
    sfx.flagCue('captured', true);
    this.burst(f.home, this.w.playerTeam, 2.4);
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
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const f of this.flags) {
      if (f.carrier !== carrierId) continue;
      f.carrier = null; f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.deps.lazyTerrain().getHeight(at.x, at.z);
      f.dropT = FLAG_RESET_S;
      this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
    }
  }
}
