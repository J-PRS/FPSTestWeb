/**
 * ConquestSim — the host-agnostic lattice state machine. RoomConquest
 * drove this inline until solo/offline needed the same rules without a
 * Room; the seams a host must supply (terrain, roster, wire, scores,
 * spawns, match end) are the ConquestHost interface — the dedicated
 * server and the offline client both answer them.
 *
 * Rules (constants + lattice math live in conquest.ts):
 *  - Nodes start neutral; a team can only act on a node 4-adjacent to
 *    its territory (owned nodes + its core count).
 *  - Neutral + actionable + touch → starts building for the toucher's
 *    team; BUILD_S seconds later it's captured. The build is autonomous
 *    once started — the enemy aborts it by presence-drain or blast.
 *  - Enemy owned node + actionable → presence-raze (uncontested foes in
 *    the ring for RAZE_S) or blast it to 0 → back to neutral.
 *  - Corner cores are the master nodes: same attack rules, bigger pool.
 *    A dead core ends the match for the attacker.
 *  - You CANNOT sever a chain — ownership persists regardless of
 *    connectivity; the link only gates what you can act on next.
 *  - Scoreboard = nodes held.
 */
import { CONQUEST, conquestActionable, conquestCells, conquestCores, conquestN, type ConquestNode } from './conquest.ts';
import { dhypot } from './dmath.ts';
import { aoeDamage } from './combat.ts';
import type { TeamId } from './teams.ts';
import type { StructureSpec } from './mapSpec.ts';
import { WORLD_MODEL, rosterRow } from './worldModel.ts';

export interface Vec3 { x: number; y: number; z: number }

/** A live body for the touch-ring scan — servers and solo bots both fit. */
export interface ConquestBody {
  id: string;
  team?: string;
  position: Vec3;
  isDead?: boolean;
}

/** What the environment must provide — every field maps 1:1 to what
 *  RoomConquest used to reach into Room for. */
export interface ConquestHost {
  groundAt(x: number, z: number): number;
  bodies(): Iterable<ConquestBody>;
  /** Shooter id → team — blast credit needs it; unknown ids mean the
   *  blast doesn't count (spectator/env). */
  teamOf(id: string | undefined): TeamId | undefined;
  /** One roster covers the whole lifecycle — the server's broadcast or
   *  the solo client's direct onNodeUpdate call. */
  emitNodes(rows: Record<string, unknown>[]): void;
  setScores(alpha: number, bravo: number): void;
  /** Node-linked respawns — owned nodes mint spawn spheres + the cores
   *  are the team bases. Optional: a host without a team-spawn seam just
   *  keeps its authored spawns. */
  setSpawns?(rings: Record<TeamId, { x: number; y: number; z: number; r: number }[]>,
             bases: Record<TeamId, Vec3>): void;
  /** Analytics/telemetry sink (server influence board). Optional. */
  splat?(pos: Vec3): void;
  endMatch?(winner: TeamId): void;
}

/** Bot goal descriptor — the same shape botRouting.flagGoal returns so
 *  brains stay mode-agnostic. */
export interface ConquestObjective {
  pos: Vec3;
  infiltrating: boolean;
}

export class ConquestSim {
  readonly nodes: ConquestNode[] = [];
  /** Kit specs mirroring the lattice — rebuilt in layout(); pos aliases
   *  the live node vec so terrain re-snaps reach the wire echo. */
  private nodeSpecs: StructureSpec[] = [];
  private n = 3;
  private dirty = true;
  /** Ownership flips — soak telemetry (cap churn, not just the scoreline). */
  private flips = 0;
  /** Per-tick touch-ring tally: node.id → live bodies by team. */
  private readonly presence = new Map<number, { alpha: number; bravo: number }>();
  /** Bot → node assignment — the coordinator state. objectiveFor
   *  consults this instead of a free per-bot pick, so the squad masses
   *  ~NODE_STAFF_MAX per priority node rather than fanning one-per-node
   *  (UT's TeamAI/SquadAI in ~60 lines). Sticky: reassessed only when
   *  the TTL lapses or the node stops being a valid target — the
   *  replan-every-think twitch lives and dies in this map. */
  private readonly assignments = new Map<string, { node: number; t: number; team: TeamId }>();
  /** Accumulated sim time — deterministic, no wall clock in sims. */
  private simT = 0;

  constructor(private readonly host: ConquestHost, private span: number) {
    this.layout();
  }

  /** Full lattice (re)mint — ctor, match reset, and spec rotation all
   *  land here. Corner cells own the two cores; everything else neutral. */
  private layout(): void {
    this.n = conquestN(this.span);
    const cores = conquestCores(this.n);
    this.nodes.length = 0;
    const cells = conquestCells(this.span, this.n);
    for (const [i, c] of cells.entries()) {
      let core: TeamId | null = null;
      if (c.gx === cores.alpha.gx && c.gz === cores.alpha.gz) {core = 'alpha';}
      else if (c.gx === cores.bravo.gx && c.gz === cores.bravo.gz) {core = 'bravo';}
      // shortcut: node sits at the cell center snapped to the draw
      // surface — a cell that lands inside a hill needs a nudge pass
      // (spiral-search nearest legal spot) when a real map buries one.
      this.nodes.push({
        id: i, gx: c.gx, gz: c.gz,
        pos: { x: c.x, y: this.host.groundAt(c.x, c.z), z: c.z },
        owner: core ?? 'neutral',
        hp: core ? CONQUEST.CORE_HP : CONQUEST.NODE_HP,
        buildT: 0, buildBy: null, razeT: 0,
        core: core !== null,
      });
    }
    this.syncSpawns();
    this.syncScores();
    // Structure specs alias n.pos — a later terrain re-snap writes the
    // same vec the echo/colliders read, never a stale copy.
    this.nodeSpecs = this.nodes.map((n) => ({
      kind: 'kit' as const,
      piece: n.core ? 'gendome' : 'katastand',
      pos: n.pos,
      size: { x: 1, y: 1, z: 1 },
    }));
    this.assignments.clear();
    this.dirty = true;
  }

  /** Node-linked respawns: every owned node (cores always owned) mints a
   *  spawn sphere, so territory literally projects your team forward —
   *  the Onslaught respawn rule. */
  private syncSpawns(): void {
    if (!this.host.setSpawns) {return;}
    const ring = (team: TeamId): { x: number; y: number; z: number; r: number }[] =>
      this.nodes.filter((n): boolean => n.owner === team)
        .map((n): { x: number; y: number; z: number; r: number } => ({ x: n.pos.x, y: n.pos.y, z: n.pos.z, r: CONQUEST.NODE_SPAWN_R }));
    const cores = conquestCores(this.n);
    const coreOf = (t: TeamId): ConquestNode | undefined =>
      this.nodes.find((n): boolean => n.gx === (t === 'alpha' ? cores.alpha.gx : cores.bravo.gx)
        && n.gz === (t === 'alpha' ? cores.alpha.gz : cores.bravo.gz));
    const [a, b] = [coreOf('alpha'), coreOf('bravo')];
    this.host.setSpawns(
      { alpha: ring('alpha'), bravo: ring('bravo') },
      a && b ? { alpha: Object.assign({}, a.pos), bravo: Object.assign({}, b.pos) } : { alpha: { x: 0, y: 0, z: 0 }, bravo: { x: 0, y: 0, z: 0 } });
  }

  /** Territory IS the scoreboard — held-node counts ride the same
   *  score path a cap does. */
  private syncScores(): void {
    const a = this.nodes.filter((n): boolean => n.owner === 'alpha').length;
    const b = this.nodes.filter((n): boolean => n.owner === 'bravo').length;
    this.host.setScores(a, b);
  }

  /** Node bases as structure specs — 'kit' pieces so the visual stand/
   *  dome and any colliders come through the authored-structure pipeline. */
  structures(): StructureSpec[] {
    return this.nodeSpecs;
  }

  /** The roster feed — one message covers the whole lattice lifecycle. */
  snapshot(): Record<string, unknown>[] {
    return this.nodes.map((n) => rosterRow(WORLD_MODEL.node!, 'id', n.id, {
      gx: n.gx, gz: n.gz, pos: Object.assign({}, n.pos), owner: n.owner,
      hp: Math.round(n.hp), maxHp: n.core ? CONQUEST.CORE_HP : CONQUEST.NODE_HP,
      build: Math.min(1, n.buildT / CONQUEST.BUILD_S), buildBy: n.buildBy, core: n.core,
    }));
  }

  /** Emit if changed — hosts decide what 'emit' means (wire vs direct
   *  handler call); the dirty gate is the same both ends. */
  flush(): void {
    if (!this.dirty) {return;}
    this.dirty = false;
    this.host.emitNodes(this.snapshot());
  }

  /** Standing objective for one bot — a coordinator pick, not a free
   *  nearest-query. An existing assignment that still targets a valid
   *  node is kept until the TTL lapses; only then does assign() re-score
   *  the lattice. */
  objectiveFor(p: { id: string; team?: string; position: Vec3 }): ConquestObjective | null {
    const me = p.team;
    if (me !== 'alpha' && me !== 'bravo') {return null;}
    const cur = this.assignments.get(p.id);
    const curNode = cur === undefined ? undefined : this.nodes[cur.node];
    if (curNode && cur!.team === me && this.simT - cur!.t < CONQUEST.ASSIGN_TTL_S && this.wanted(curNode, me)) {
      return this.goal(curNode, me);
    }
    const pick = this.assign(p, me);
    if (!pick) { this.assignments.delete(p.id); return null; }
    this.assignments.set(p.id, { node: pick.id, t: this.simT, team: me });
    return this.goal(pick, me);
  }

  /** Is this node still a job for team me? Owned nodes count only while
   *  contested (a secured node needs no standing garrison); anything
   *  else counts while the link chain makes it actionable. */
  private wanted(n: ConquestNode, me: TeamId): boolean {
    if (n.owner === me) {
      const foe: TeamId = me === 'alpha' ? 'bravo' : 'alpha';
      return (this.presence.get(n.id)?.[foe] ?? 0) > 0;
    }
    return conquestActionable(this.nodes, n, me, this.n);
  }

  /** Pick a node's job for one bot: priority class first (defend
   *  contested > kill core > finish raze > finish our build > fresh
   *  build), then under-staffed and near. Occupancy reads the OTHER
   *  bots' live assignments, so the squad spreads a fireteam per node
   *  instead of conga-lining the nearest one. */
  private assign(p: { id: string; position: Vec3 }, me: TeamId): ConquestNode | null {
    const foe: TeamId = me === 'alpha' ? 'bravo' : 'alpha';
    const occ = new Map<number, number>();
    for (const [id, a] of this.assignments) {
      const n = this.nodes[a.node];
      const live = n !== undefined && this.simT - a.t < CONQUEST.ASSIGN_TTL_S && this.wanted(n, a.team);
      if (!live) { this.assignments.delete(id); continue; }
      if (id !== p.id) {occ.set(a.node, (occ.get(a.node) ?? 0) + 1);}
    }
    let best: ConquestNode | null = null;
    let bestS = -Infinity;
    for (const n of this.nodes) {
      let s = -Infinity;
      if (n.owner === me) {
        const foes = this.presence.get(n.id)?.[foe] ?? 0;
        if (foes > 0) {s = 100 + foes * 5;}
      } else if (!conquestActionable(this.nodes, n, me, this.n)) {
        continue;
      } else if (n.core) {
        s = 90;
      } else if (n.owner === foe) {
        s = 60 + (1 - n.hp / CONQUEST.NODE_HP) * 20;
      } else {
        s = n.buildBy === me ? 70 + (n.buildT / CONQUEST.BUILD_S) * 10 : 50;
      }
      if (s === -Infinity) {continue;}
      const o = occ.get(n.id) ?? 0;
      if (o >= CONQUEST.NODE_STAFF_MAX) {continue;}
      // No soft occupancy penalty and no per-id jitter — the cap is the
      // spread mechanism. Same-position bots score identically, mass on
      // the best node until it's staffed, then overflow to the next.
      s -= dhypot(n.pos.x - p.position.x, n.pos.z - p.position.z) * 0.02;
      if (s > bestS) { bestS = s; best = n; }
    }
    return best;
  }

  private goal(n: ConquestNode, me: TeamId): ConquestObjective {
    return { pos: { x: n.pos.x, y: n.pos.y, z: n.pos.z }, infiltrating: n.owner !== me };
  }

  /** Bodies inside each node's touch ring — 2D ring + a vertical slack
   *  band so a flyer 10m over the pad isn't "on" it. */
  private scanPresence(): void {
    this.presence.clear();
    const r2 = CONQUEST.TOUCH_R * CONQUEST.TOUCH_R;
    for (const p of this.host.bodies()) {
      if (p.isDead || (p.team !== 'alpha' && p.team !== 'bravo')) {continue;}
      for (const n of this.nodes) {
        const dx = p.position.x - n.pos.x, dz = p.position.z - n.pos.z;
        if (dx * dx + dz * dz > r2 || Math.abs(p.position.y - n.pos.y) > 12) {continue;}
        const pr = this.presence.get(n.id) ?? { alpha: 0, bravo: 0 };
        pr[p.team as TeamId] += 1;
        this.presence.set(n.id, pr);
      }
    }
    for (const n of this.nodes) {
      if (!this.presence.has(n.id)) {this.presence.set(n.id, { alpha: 0, bravo: 0 });}
    }
  }

  tick(dt: number): void {
    this.simT += dt;
    this.scanPresence();
    for (const n of this.nodes) {
      const pr = this.presence.get(n.id)!;
      if (n.owner === 'neutral') {this.tickNeutral(n, pr, dt);}
      else if (n.core) {this.tickOwned(n, pr, dt, CONQUEST.CORE_RAZE_S, true);}
      else {this.tickOwned(n, pr, dt, CONQUEST.RAZE_S, false);}
    }
    this.flush();
  }

  /** Owned node or core: uncontested linked enemies in the ring drain it
   *  toward neutral (or a match-ending core kill); defenders present or
   *  absent freeze then bleed the timer back. */
  private tickOwned(n: ConquestNode, pr: { alpha: number; bravo: number }, dt: number, razeS: number, core: boolean): void {
    const foe: TeamId = n.owner === 'alpha' ? 'bravo' : 'alpha';
    const foeOnly = pr[foe] > 0 && pr[n.owner as TeamId] === 0;
    if (foeOnly && conquestActionable(this.nodes, n, foe, this.n)) {
      n.razeT += dt;
      this.dirty = true;
      if (n.razeT >= razeS) {
        if (core) {this.coreDown(n, foe);}
        else {this.neutralize(n);}
      }
      return;
    }
    if (n.razeT > 0) {n.razeT = Math.max(0, n.razeT - dt * 0.5);}
  }

  /** Neutral node: an unbuilt one wants a linked team's touch to start
   *  building; a building one finishes on its own unless the other team
   *  drains it (linked presence) or blasts it flat. Contested = frozen. */
  private tickNeutral(n: ConquestNode, pr: { alpha: number; bravo: number }, dt: number): void {
    if (n.buildBy && n.buildT > 0) {
      const foe: TeamId = n.buildBy === 'alpha' ? 'bravo' : 'alpha';
      if (pr[foe] > 0 && pr[n.buildBy] === 0 && conquestActionable(this.nodes, n, foe, this.n)) {
        n.buildT -= dt * 2;
        this.dirty = true;
        if (n.buildT <= 0) {n.buildT = 0; n.buildBy = null;}
      } else {
        n.buildT += dt;
        if (n.buildT >= CONQUEST.BUILD_S) {this.capture(n, n.buildBy);}
        else {this.dirty = true;}
      }
      return;
    }
    // First touch arms the build — exactly one team present, and only
    // when its chain reaches (you can't touch across enemy territory).
    let t: TeamId | null = null;
    if (pr.alpha > 0 && pr.bravo === 0) {t = 'alpha';}
    else if (pr.bravo > 0 && pr.alpha === 0) {t = 'bravo';}
    if (!t || !conquestActionable(this.nodes, n, t, this.n)) {return;}
    n.buildBy = t;
    n.buildT = dt;
    this.dirty = true;
  }

  /** Blast stream → node damage, gated by the shooter's link chain:
   *  owned nodes lose hp to neutral, building nodes lose build progress,
   *  cores lose hp toward a match end. Friendly nodes are immune. */
  applyBlast(pos: Vec3, damage: number, radius: number, shooterId: string | undefined, scales?: readonly number[]): void {
    const team = this.host.teamOf(shooterId);
    if (team !== 'alpha' && team !== 'bravo') {return;}
    for (const n of this.nodes) {
      const dist = dhypot(n.pos.x - pos.x, n.pos.y - pos.y, n.pos.z - pos.z);
      if (dist >= radius || !conquestActionable(this.nodes, n, team, this.n)) {continue;}
      if (n.owner === team || n.buildBy === team) {continue;}
      const dmg = aoeDamage(damage, dist, radius, scales);
      if (dmg > 0) {this.damageNode(n, dmg, team);}
    }
  }

  /** One blast's effect on one reachable node — cores and owned nodes
   *  lose hp, buildings lose build progress (converted through NODE_HP). */
  private damageNode(n: ConquestNode, dmg: number, attacker: TeamId): void {
    this.dirty = true;
    if (n.owner !== 'neutral') {
      n.hp -= dmg;
      if (n.hp <= 0) {
        if (n.core) {this.coreDown(n, attacker);}
        else {this.neutralize(n);}
      }
      return;
    }
    if (n.buildT > 0) {
      n.buildT -= dmg * CONQUEST.BUILD_S / CONQUEST.NODE_HP;
      if (n.buildT <= 0) {n.buildT = 0; n.buildBy = null;}
    }
  }

  private capture(n: ConquestNode, team: TeamId): void {
    n.owner = team;
    n.hp = CONQUEST.NODE_HP;
    n.razeT = 0;
    this.flips += 1;
    this.host.splat?.(n.pos);
    this.syncSpawns();
    this.syncScores();
    this.dirty = true;
  }

  private neutralize(n: ConquestNode): void {
    n.owner = 'neutral';
    n.hp = CONQUEST.NODE_HP;
    n.buildT = 0;
    n.buildBy = null;
    n.razeT = 0;
    this.flips += 1;
    this.host.splat?.(n.pos);
    this.syncSpawns();
    this.syncScores();
    this.dirty = true;
  }

  private coreDown(n: ConquestNode, attacker: TeamId): void {
    n.hp = 0;
    this.dirty = true;
    this.host.endMatch?.(attacker);
  }

  /** Match boundary — a fresh match re-mints the lattice. */
  reset(): void {
    this.layout();
  }

  /** Spec rotation — the lattice re-derives on the new span. */
  onSpec(span: number): void {
    this.span = span;
    this.layout();
  }

  /** Live terrain (re)attach — re-snap heights, keep the ownership map. */
  onTerrain(): void {
    for (const n of this.nodes) {n.pos.y = this.host.groundAt(n.pos.x, n.pos.z);}
    this.dirty = true;
  }

  telemetry(): string {
    let a = 0, b = 0;
    let ca = 0, cb = 0;
    const cores = conquestCores(this.n);
    for (const n of this.nodes) {
      if (n.owner === 'alpha') {a += 1;}
      else if (n.owner === 'bravo') {b += 1;}
      if (n.gx === cores.alpha.gx && n.gz === cores.alpha.gz) {ca = n.hp;}
      if (n.gx === cores.bravo.gx && n.gz === cores.bravo.gz) {cb = n.hp;}
    }
    return `conq nodes a=${a} b=${b} neutral=${this.nodes.length - a - b} flips=${this.flips} coreHp=${Math.round(ca)}/${Math.round(cb)}`;
  }
}
