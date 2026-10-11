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
import type { GameBot } from './bots/botBrain.js';
import { flagReturnFx } from './flagFx.js';
import * as sfx from '../core/sfx.js';
import { GRAVITY } from '../core/config.js';
import { Explosion } from '../effects/explosion.js';
import { urlParams } from '../core/params.js';
import { noteLocalSnap } from './gameLoop.js';
import { MoveSim, type MoveSurface } from '../../../shared/movement.js';

const FLAG_BASE_GEO = new THREE.IcosahedronGeometry(0.4, 0);
const _filmDir = new THREE.Vector3();
const _filmUp = new THREE.Vector3(0, 9, 0);
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
    energy?: number; vel?: THREE.Vector3; yaw: number; pitch: number;
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
  /** Loose-flag ballistic velocity — mirrors RoomFlags.vel: nonzero
   *  means the flag is tumbling, not resting. */
  flyVel: THREE.Vector3;
  /** Whose toss is still airborne — same re-grab guard the server
   *  applies so you can't instantly re-catch your own throw. */
  airborneBy: string | null;
}

export interface FlagRunWiring {
  playerTeam: TeamId;
  bots: GameBot[];
  teamOf: Map<string, string>;
  scores: TeamScores;
  onFeed(t: string): void;
  onCapture(team: TeamId): void;
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
      this.flags.push({ mesh, stand, home, pos: home.clone(), state: 'home', team, carrier: null, dropT: 0, flyVel: new THREE.Vector3(), airborneBy: null });
    });
    w.onFeed(`FLAG RUN — grab an enemy flag, bank it at any ${TEAM_LABEL[w.playerTeam]} stand.`);
    if (urlParams.has('tas')) {this.loadTasGhost();}
  }

  /** Scene teardown — same leak class as CtfFlags: orphaned stand+flag
   *  meshes keep rendering after the offline match retires. */
  dispose(): void {
    const scene = this.deps.lazyScene();
    for (const f of this.flags) {scene.remove(f.mesh, f.stand);}
    this.flags.length = 0;
    if (this.tasGhost) { scene.remove(this.tasGhost); this.tasGhost = undefined; }
  }

  /** TAS ghost — replays a searched optimal leg trajectory (the yellow
   *  ribbon + flying marker) so the arc is watchable in-engine.
   *  ?tas=0->1 picks a leg; ?tas=1 plays the first found. */
  private tasPts: THREE.Vector3[] = [];
  private tasJet: boolean[] = [];
  private tasT = 0;
  private readonly tasStep = 0.15;
  private tasGhost?: THREE.Group;
  private tasMat?: THREE.MeshBasicMaterial;
  private tasSrc?: CircuitFlag;
  private tasSpeedCtx?: CanvasRenderingContext2D;
  private tasSpeedTex?: THREE.CanvasTexture;
  private tasSpeedTxt = '';

  private async loadTasGhost(): Promise<void> {
    const terrain = this.deps.lazyTerrain();
    const scene = this.deps.lazyScene();
    const data = await fetch('/assets/tas_paths.json').then(r => r.json()).catch(() => null);
    if (!data) { this.w.onFeed('TAS ghost: no tas_paths.json — run .devin_tas.ts first.'); return; }
    const want = urlParams.get('tas');
    const key = want && want.includes('->') ? want : Object.keys(data)[0]!;
    const leg = data[key];
    if (!leg) { this.w.onFeed(`TAS ghost: no leg ${key} — have: ${Object.keys(data).join(' ')}`); return; }
    this.tasPts = leg.samples.map((s: { x: number; z: number; agl: number }) =>
      new THREE.Vector3(s.x, terrain.getHeight(s.x, s.z) + s.agl, s.z));
    this.tasJet = leg.samples.map((s: { j: number }) => s.j === 1);
    // Real-sim proof: replay the recorded input tape (yaw + jetHeld, ski
    // held, forward) through a fresh MoveSim on the live terrain — the
    // SAME physics class the player/bot entities run — and fly the
    // marker on the re-simulated positions, not the recorded ones.
    const simPts: THREE.Vector3[] = [];
    const surface: MoveSurface = {
      getHeight: (x, z) => terrain.getHeight(x, z),
      getNormal: (x, z, out) => { const n = terrain.getNormal(x, z); out.x = n.x; out.y = n.y; out.z = n.z; return out; },
    };
    const start2 = this.tasPts[0]!;
    const leg2 = leg as { samples: { yaw: number; j: number }[] };
    const sim = new MoveSim(surface, {
      pos: { x: start2.x, y: start2.y, z: start2.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: leg2.samples[0]!.yaw, pitch: 0, onGround: true,
    } as MoveSim['state']);
    let maxDrift = 0;
    for (let i = 0; i < this.tasPts.length; i += 1) {
      const s = sim.state;
      simPts.push(new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z));
      maxDrift = Math.max(maxDrift, Math.hypot(s.pos.x - this.tasPts[i]!.x, s.pos.z - this.tasPts[i]!.z, s.pos.y - this.tasPts[i]!.y));
      if (i + 1 < this.tasPts.length) {
        s.yaw = leg2.samples[i + 1]!.yaw;
        sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: leg2.samples[i + 1]!.j === 1 });
        for (let k = 0; k < 9; k += 1) {sim.update(1 / 60);}
      }
    }
    // The search scored "goal" at ring crossing (≤40m above the stand) —
    // keep coasting the sim until touchdown so the path visibly lands.
    sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: false });
    for (let k = 0; k < 240 && !sim.state.onGround; k += 1) {
      sim.update(1 / 60);
      if (k % 9 === 8) { const s = sim.state; simPts.push(new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z)); }
    }
    const goal = this.tasPts[this.tasPts.length - 1]!;
    const end = simPts[simPts.length - 1]!;
    const goalMiss = Math.hypot(goal.x - end.x, goal.z - end.z);
    this.w.onFeed(`TAS replay: in-engine sim drift ${maxDrift.toFixed(1)}m, lands ${goalMiss.toFixed(1)}m from target`);
    this.tasPts = simPts;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(this.tasPts),
      new THREE.LineBasicMaterial({ color: 0xFF_D8_4D, transparent: true, opacity: 0.7 }));
    this.tasMat = new THREE.MeshBasicMaterial({ color: 0xFF_40_60 });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 8), this.tasMat);
    // Carried-flag prop — the leg is a grab→cap flight, so the marker
    // needs the enemy standard on its back or it reads as a stray spark.
    const start = this.tasPts[0]!;
    const src = this.flags.reduce((a, b) => a.home.distanceToSquared(start) < b.home.distanceToSquared(start) ? a : b);
    this.tasSrc = src;
    const prop = mkFlagMesh(src.team);
    prop.scale.setScalar(0.9);
    prop.position.set(0, -0.4, 0);
    dot.add(prop);
    // Speed readout — a sprite that floats over the marker so the film
    // carries the live m/s through the arc.
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 72;
    this.tasSpeedCtx = cv.getContext('2d')!;
    this.tasSpeedTex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tasSpeedTex, depthTest: false }));
    sp.scale.set(14, 3.9, 1);
    sp.position.set(0, 4.4, 0);
    dot.add(sp);
    const g = new THREE.Group();
    g.add(line, dot);
    this.tasGhost = g;
    scene.add(g);
    this.w.onFeed(`TAS ghost: leg ${key} — ${leg.t.toFixed(1)}s optimal${leg.miss ? ` (miss ${leg.miss.toFixed(0)}m)` : ''}`);
  }

  private tickTasGhost(dt: number): void {
    if (this.tasPts.length === 0 || !this.tasGhost) {return;}
    this.tasT += dt;
    // 1s hold at each end: grab beat on the source stand, cap beat on the
    // goal stand — the flight is sandwiched so the loop reads as a cap.
    const HOLD = 1;
    const flight = this.tasPts.length * this.tasStep;
    const t = this.tasT % (flight + HOLD * 2);
    const ft = Math.max(0, Math.min(t - HOLD, flight)) / this.tasStep;
    const i = Math.min(this.tasPts.length - 2, Math.floor(ft));
    const dot = this.tasGhost.children[1] as THREE.Mesh;
    dot.position.lerpVectors(this.tasPts[i]!, this.tasPts[i + 1]!, ft - i);
    const atEnd = t >= flight + HOLD;
    (dot.material as THREE.MeshBasicMaterial).color.setHex(
      t < HOLD || atEnd ? 0xFF_D8_4D : this.tasJet[i] ? 0x40_FF_90 : 0xFF_40_60);
    // The real source flag leaves its stand while the ghost carries it —
    // otherwise the "grab" shows a copy flying and the original seated.
    if (this.tasSrc) {this.tasSrc.mesh.visible = t < HOLD || atEnd;}
    // Live speed label over the marker (sample-spacing / step duration).
    const spd = this.tasPts[i + 1]!.distanceTo(this.tasPts[i]!) / this.tasStep;
    const spdTxt = atEnd ? 'CAP' : t < HOLD ? 'GRAB' : `${spd.toFixed(0)} m/s`;
    if (spdTxt !== this.tasSpeedTxt && this.tasSpeedCtx && this.tasSpeedTex) {
      this.tasSpeedTxt = spdTxt;
      const c = this.tasSpeedCtx;
      c.clearRect(0, 0, 256, 72);
      c.font = 'bold 44px monospace';
      c.textAlign = 'center';
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillRect(0, 0, 256, 72);
      c.fillStyle = '#ffe27a';
      c.fillText(spdTxt, 128, 52);
      this.tasSpeedTex.needsUpdate = true;
    }
    // ?film=1 — chase cam: park the local player on the dot's tail so the
    // ordinary camera pipeline frames the flight (recording aid only).
    if (urlParams.has('film')) {
      const p = this.deps.lazyPlayer();
      if (!p.isDead) {
        const dir = _filmDir.subVectors(this.tasPts[Math.min(i + 1, this.tasPts.length - 1)]!, this.tasPts[i]!);
        if (dir.lengthSq() > 0.001) {
          dir.normalize();
          p.pos.copy(dot.position).addScaledVector(dir, -28).add(_filmUp);
          noteLocalSnap(); // chase-cam seat is a designed teleport
          p.vel?.set(0, 0, 0);
          p.yaw = Math.atan2(dir.x, dir.z);
          p.pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
        }
      }
    }
  }

  /** Spawn/respawn anchor — beside the nearest live enemy flag. */
  spawnPoint(): THREE.Vector3 | null {
    const p = this.playerPos;
    if (!p) {return this.flags.find(f => f.team !== this.w.playerTeam)?.home ?? null;}
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of this.flags) {
      if (f.team === this.w.playerTeam || f.state === 'carried') {continue;}
      const d = f.home.distanceToSquared(p);
      if (d < bd) { bd = d; best = f.home; }
    }
    return best;
  }

  // Frame-ago toucher positions — same swept-tap convention as CtfBridge.
  private lastTouchPos = new Map<string, THREE.Vector3>();
  // Last measured toucher speed (m/s) — grab/cap feed lines quote it.
  private lastTouchV = new Map<string, number>();

  /** Jersey swap — same body keeps its touch-receipt continuity. */
  rekey(oldId: string, newId: string): void {
    const p = this.lastTouchPos.get(oldId);
    this.lastTouchPos.delete(oldId);
    if (p !== undefined) {this.lastTouchPos.set(newId, p);}
    const v = this.lastTouchV.get(oldId);
    this.lastTouchV.delete(oldId);
    if (v !== undefined) {this.lastTouchV.set(newId, v);}
  }

  update(dt: number): void {
    this.tickTasGhost(dt);
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
this.eN += 1;
      const v = Math.hypot(player.vel?.x ?? 0, player.vel?.z ?? 0);
      if (v > this.maxV) {this.maxV = v;}
      this.lastTouchV.set('local', v);
      this.lastTouchPos.set('local', (this.lastTouchPos.get('local') ?? new THREE.Vector3()).copy(player.pos));
      touchers.push(['local', player.pos, prev]);
    }
    for (const b of this.w.bots) {
      if (b.isDead) {continue;}
      let prev = this.lastTouchPos.get(b.playerId);
      if (!prev) {this.lastTouchPos.set(b.playerId, (prev = b.position.clone()));}
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
            if (f.pos.distanceTo(home) >= FLAG_HOME_R + STAND_TOP) {continue;}
            this.cap(f);
            break;
          }
        } else {
          this.setBotCarry(f.carrier, false);
          f.state = 'dropped'; f.carrier = null;
          // Same tumble pop the server gives a dead carrier's flag
          // (loose(): +3 up) — the ballistic tick owns it from here.
          f.flyVel.set(0, 3, 0);
          f.dropT = FLAG_RESET_S;
          this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
        }
        continue;
      }
      if (f.state === 'dropped') {
        this.tickBallistic(f, dt);
        f.dropT -= dt;
        if (f.dropT <= 0) {this.sendHome(f, 'returned');}
      }
      // home/dropped both accept touches — swept capsule like CtfFlags.
      for (const [id, tp, pp] of touchers) {
        if (id === f.airborneBy) {continue;} // thrower can't re-grab mid-flight
        const tTeam = this.w.teamOf.get(id);
        if (f.state === 'dropped' && tTeam === f.team) { this.sendHome(f, 'returned'); break; }
        if (tTeam === f.team) {continue;}
        const segLen2 = pp.distanceToSquared(tp);
        const t = segLen2 > 0 ? Math.min(1, Math.max(0,
          ((f.pos.x - pp.x) * (tp.x - pp.x) + (f.pos.y - pp.y) * (tp.y - pp.y) + (f.pos.z - pp.z) * (tp.z - pp.z)) / segLen2)) : 0;
        const dx = pp.x + (tp.x - pp.x) * t - f.pos.x;
        const dy = pp.y + (tp.y - pp.y) * t - f.pos.y;
        const dz = pp.z + (tp.z - pp.z) * t - f.pos.z;
        // Server touch rule: |dy|<=6 vertical + planar radius — the deck
        // puts the flag ~3m over your feet, a 3D sphere would miss.
        const pickupR = FLAG_PICKUP_R * (id === 'local' ? (player.mods.pickupRadius ?? 1) : 1);
        if (Math.abs(dy) > 6 || dx * dx + dz * dz > pickupR * pickupR) {continue;}
        f.state = 'carried'; f.carrier = id;
        f.airborneBy = null; f.flyVel.set(0, 0, 0);
        this.setBotCarry(id, true);
        this.burst(f.pos, f.team, 1.4);
        sfx.flagCue('taken', false);
        const gv = (this.lastTouchV.get(id) ?? 0).toFixed(0);
        this.w.onFeed(id === 'local' ? `YOU took the ${TEAM_LABEL[f.team]} flag AT ${gv} m/s!`
          : `${id.replace('bot:', '')} took the ${TEAM_LABEL[f.team]} flag AT ${gv} m/s!`);
        break;
      }
      f.mesh.position.copy(f.pos);
      if (f.state === 'home') {f.mesh.position.y += STAND_TOP;}
    }
    // Markers: one pin per stand, lifted to deck height.
    const cam = this.deps.lazyCamera();
    const hud = this.deps.lazyHud();
    for (const f of this.flags) {
      const lift = f.state === 'home' ? STAND_TOP : 0;
      f.pos.y += 3.4 + lift;
      hud.updateFlagIndicator(`fr:${f.home.x}:${f.home.z}`, f.pos, cam, f.team);
      // Home flag: socket nests INSIDE the flag diamond — one complete
      // glyph, same as the wire path. Away: the bare socket marks the
      // empty stand at deck height.
      if (f.state === 'home') {
        hud.updateFlagIndicator(`frs:${f.home.x}:${f.home.z}`, f.pos, cam, f.team, 'stand');
      } else {
        f.home.y += STAND_TOP + 0.07;
        hud.updateFlagIndicator(`frs:${f.home.x}:${f.home.z}`, f.home, cam, f.team, 'stand');
        f.home.y -= STAND_TOP + 0.07;
      }
      f.pos.y -= 3.4 + lift;
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
    if (b) {b.carryingFlag = v;}
  }

  /** Bot objective for flagrun — grab the nearest enemy flag, bank it at
   *  the nearest friendly stand. Same shape CtfBridge feeds brains. */
  objectiveInfoFor(bot: GameBot): { pos: THREE.Vector3; infiltrating: boolean;
    running?: boolean; thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } } | null {
    const myTeam: TeamId = bot.team === 'bravo' ? 'bravo' : 'alpha';
    if (bot.carryingFlag) {
      let home: THREE.Vector3 | null = null, hd = Infinity;
      for (const f of this.flags) {
        if (f.team !== myTeam) {continue;}
        const d = f.home.distanceToSquared(bot.position);
        if (d < hd) { hd = d; home = f.home; }
      }
      return home ? { pos: home.clone(), infiltrating: false, running: true } : null;
    }
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of this.flags) {
      if (f.team === myTeam || f.state === 'carried') {continue;}
      const d = f.pos.distanceToSquared(bot.position);
      if (d < bd) { bd = d; best = f.pos; }
    }
    return best
      ? { pos: new THREE.Vector3(best.x, best.y + STAND_LIFT, best.z), infiltrating: true }
      : null;
  }

  private cap(f: CircuitFlag): void {
this.caps += 1;
    const cTeam = (f.carrier ? this.w.teamOf.get(f.carrier) : null) as TeamId | null ?? this.w.playerTeam;
    this.setBotCarry(f.carrier, false);
    bank(this.w.scores, cTeam);
    this.w.onCapture(cTeam);
    const cv = (f.carrier ? this.lastTouchV.get(f.carrier) ?? 0 : 0).toFixed(0);
    this.w.onFeed(`CAP ${this.caps % LAP_CAPS || LAP_CAPS}/${LAP_CAPS} — ${this.capT.toFixed(1)}s AT ${cv} m/s`);
    if (this.capT < this.bestCap) {this.bestCap = this.capT;}
    sfx.flagCue('captured', true);
    this.burst(f.home, cTeam, 2.4);
    if (this.caps % LAP_CAPS === 0) {
this.lap += 1;
      if (this.lapT < this.bestLap) {this.bestLap = this.lapT;}
      this.w.onFeed(`LAP ${this.lap} — ${this.lapT.toFixed(1)}s  (best ${this.bestLap.toFixed(1)}s)`);
      this.lapT = 0;
    }
    this.capT = 0;
    this.sendHome(f, 'captured');
  }

  private sendHome(f: CircuitFlag, kind: 'returned' | 'captured'): void {
    f.state = 'home'; f.carrier = null; f.pos.copy(f.home);
    f.flyVel.set(0, 0, 0); f.airborneBy = null;
    if (kind === 'returned') { sfx.flagCue('returned', f.team === this.w.playerTeam); flagReturnFx(f.pos, f.team, null); }
    this.burst(f.pos, f.team, kind === 'captured' ? 2.4 : 1.4);
  }

  private burst(at: THREE.Vector3, team: TeamId, power: number): void {
    this.deps.world.explosions.push(new Explosion(
      this.deps.lazyScene(), new THREE.Vector3(at.x, at.y + 1.2, at.z), false, 0,
      this.deps.lazyTerrain(), power, TEAM_COLORS[team]));
  }

  reset(): void {
    for (const f of this.flags) { f.state = 'home'; f.carrier = null; f.pos.copy(f.home); f.flyVel.set(0, 0, 0); f.airborneBy = null; }
    this.caps = 0; this.lap = 0; this.lapT = 0; this.capT = 0;
    this.pathM = 0; this.liveS = 0; this.eSum = 0; this.eN = 0;
    this.maxV = 0; this.bestCap = Infinity; this.bestLap = Infinity;
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const f of this.flags) {
      if (f.carrier !== carrierId) {continue;}
      this.setBotCarry(carrierId, false);
      f.carrier = null; f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.deps.lazyTerrain().getHeight(at.x, at.z);
      f.flyVel.set(0, 0, 0); f.airborneBy = null;
      f.dropT = FLAG_RESET_S;
      this.w.onFeed(`${TEAM_LABEL[f.team]} flag dropped!`);
    }
  }

  /** Local G-press flag toss — same claim the server resolves online
   *  (RoomFlags.throwFor): FULL carrier speed inherited plus a
   *  deliberate lob along aim. Same constants both ends so the offline
   *  arc reads identical to the wire replay. */
  throwLocal(): void {
    const player = this.deps.lazyPlayer();
    if (player.isDead) {return;}
    for (const f of this.flags) {
      if (f.carrier !== 'local') {continue;}
      const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
      this.setBotCarry('local', false);
      f.carrier = null; f.state = 'dropped';
      f.pos.copy(player.pos);
      f.flyVel.set(
        (player.vel?.x ?? 0) + cp * Math.sin(player.yaw) * 20,
        (player.vel?.y ?? 0) + 3 + sp * 20,
        (player.vel?.z ?? 0) + cp * Math.cos(player.yaw) * 20);
      f.airborneBy = 'local';
      f.dropT = FLAG_RESET_S;
      this.w.onFeed(`${TEAM_LABEL[f.team]} flag thrown!`);
    }
  }

  /** Loose-flag tumble — mirrors RoomFlags.tickBallistic (world
   *  gravity, 0.3 bounce, 4/s skid bleed, 0.6 settle). */
  private tickBallistic(f: CircuitFlag, dt: number): void {
    if (f.flyVel.x === 0 && f.flyVel.y === 0 && f.flyVel.z === 0) {return;}
    f.flyVel.y += GRAVITY * dt;
    f.pos.addScaledVector(f.flyVel, dt);
    const gy = this.deps.lazyTerrain().getHeight(f.pos.x, f.pos.z) + 0.2;
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
}
