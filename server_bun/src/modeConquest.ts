/**
 * RoomConquest — the conquest (UT-Onslaught-style lattice) mode module.
 * Everything the mode owns lives here: the procedural node grid, the
 * touch-to-build / presence-raze / blast-damage state machine, the
 * node-linked spawn pools, the scoreboard sync, the wire feed and the
 * bot objective provider. Room only knows the ModeModule seam — the
 * mode could be deleted by removing one registry line in modeModules.
 *
 * Rules (see shared/conquest.ts for the shared constants + lattice math):
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
 *  - Scoreboard = nodes held, so the horn resolves on territory.
 */
import { CONQUEST, conquestActionable, conquestCells, conquestCores, conquestN, type ConquestNode } from '../../shared/conquest.ts';
import { aoeDamage } from '../../shared/combat.ts';
import type { TeamId, TeamScores } from '../../shared/teams.ts';
import type { MapSpec } from '../../shared/mapSpec.ts';
import { HM_WORLD_SCALE } from '../../shared/heightfield.ts';
import { WORLD_MODEL, rosterRow } from '../../shared/worldModel.ts';
import { logger } from './logger.ts';
import type { Room } from './Room.ts';
import type { ModeModule, ModeObjective } from './modeModules.ts';
import type { RoomEvent } from './roomEvents.ts';
import type { Vec3, ServerMessage } from './types.ts';

export class RoomConquest implements ModeModule {
  readonly nodes: ConquestNode[] = [];
  private n = 3;
  private dirty = true;
  /** Ownership flips — soak telemetry (cap churn, not just the scoreline). */
  private flips = 0;
  /** Per-tick touch-ring tally: node.id → live bodies by team. */
  private readonly presence = new Map<number, { alpha: number; bravo: number }>();

  constructor(private readonly room: Room) {
    this.layout();
    // Nodes eat the same blast stream deployables do — no new damage
    // plumbing; hitscan can't hurt them (nodes are blast-only, matching
    // the codebase's blast-durability rule for objectives).
    this.room.events.on((e: RoomEvent): void => {
      if (e.type === 'blast') {this.applyBlast(e.pos, e.damage, e.radius, e.shooterId, e.scales);}
    });
  }

  private groundAt(x: number, z: number): number {
    return this.room.players.groundAt?.(x, z) ?? 0;
  }

  /** Full lattice (re)mint — ctor, match reset, and spec rotation all
   *  land here. Corner cells own the two cores; everything else neutral. */
  private layout(): void {
    const span = this.room.spec.tileSize ?? HM_WORLD_SCALE;
    this.n = conquestN(span);
    const cores = conquestCores(this.n);
    this.nodes.length = 0;
    const cells = conquestCells(span, this.n);
    for (const [i, c] of cells.entries()) {
      let core: TeamId | null = null;
      if (c.gx === cores.alpha.gx && c.gz === cores.alpha.gz) {core = 'alpha';}
      else if (c.gx === cores.bravo.gx && c.gz === cores.bravo.gz) {core = 'bravo';}
      // shortcut: node sits at the cell center snapped to the draw
      // surface — a cell that lands inside a hill needs a nudge pass
      // (spiral-search nearest legal spot) when a real map buries one.
      this.nodes.push({
        id: i, gx: c.gx, gz: c.gz,
        pos: { x: c.x, y: this.groundAt(c.x, c.z), z: c.z },
        owner: core ?? 'neutral',
        hp: core ? CONQUEST.CORE_HP : CONQUEST.NODE_HP,
        buildT: 0, buildBy: null, razeT: 0,
        core: core !== null,
      });
    }
    this.syncSpawns();
    this.syncScores();
    this.dirty = true;
  }

  /** Node-linked respawns: every owned node (cores always owned) mints a
   *  spawn sphere, so territory literally projects your team forward —
   *  the Onslaught respawn rule riding the existing teamSpawns picker. */
  private syncSpawns(): void {
    const ring = (team: TeamId): { x: number; y: number; z: number; r: number }[] =>
      this.nodes.filter((n): boolean => n.owner === team)
        .map((n): { x: number; y: number; z: number; r: number } => ({ x: n.pos.x, y: n.pos.y, z: n.pos.z, r: CONQUEST.NODE_SPAWN_R }));
    this.room.players.teamSpawns = { alpha: ring('alpha'), bravo: ring('bravo') };
    const cores = conquestCores(this.n);
    const coreOf = (t: TeamId): ConquestNode | undefined =>
      this.nodes.find((n): boolean => n.gx === (t === 'alpha' ? cores.alpha.gx : cores.bravo.gx)
        && n.gz === (t === 'alpha' ? cores.alpha.gz : cores.bravo.gz));
    const [a, b] = [coreOf('alpha'), coreOf('bravo')];
    if (a && b) {this.room.players.teamBases = { alpha: Object.assign({}, a.pos), bravo: Object.assign({}, b.pos) };}
  }

  /** Territory IS the scoreboard — the horn's leader() reads scores, so
   *  held-node counts go through the same teamScore broadcast a cap does. */
  private syncScores(): void {
    const a = this.nodes.filter((n): boolean => n.owner === 'alpha').length;
    const b = this.nodes.filter((n): boolean => n.owner === 'bravo').length;
    const s = this.room.scores;
    if (s.alpha === a && s.bravo === b) {return;}
    s.alpha = a;
    s.bravo = b;
    this.room.broadcast({ type: 'teamScore', scores: Object.assign({}, s as TeamScores), winAt: this.room.modeSpec?.winAt ?? 999 });
  }

  /** The roster feed — one message covers the whole lattice lifecycle. */
  snapshot(): Record<string, unknown>[] {
    return this.nodes.map((n) => rosterRow(WORLD_MODEL.node!, 'id', n.id, {
      gx: n.gx, gz: n.gz, pos: Object.assign({}, n.pos), owner: n.owner,
      hp: Math.round(n.hp), maxHp: n.core ? CONQUEST.CORE_HP : CONQUEST.NODE_HP,
      build: Math.min(1, n.buildT / CONQUEST.BUILD_S), core: n.core,
    }));
  }

  sims(): { name: string; tick(dt: number): void; worldState(): ServerMessage[] }[] {
    return [{
      name: 'nodes',
      tick: (dt: number): void => this.tick(dt),
      worldState: (): ServerMessage[] => [{ type: 'nodeUpdate', nodes: this.snapshot() } as ServerMessage],
    }];
  }

  /** Standing objective for one bot — nearest actionable frontier node,
   *  or a contested owned node worth defending. The pick scores distance
   *  with a stable per-id spread so the squad doesn't conga one node. */
  objectiveFor(p: { id: string; team?: string; position: Vec3 }): ModeObjective | null {
    const me = p.team;
    if (me !== 'alpha' && me !== 'bravo') {return null;}
    const foe: TeamId = me === 'alpha' ? 'bravo' : 'alpha';
    let h = 0;
    for (let i = 0; i < p.id.length; i += 1) {h = (h * 31 + p.id.charCodeAt(i)) >>> 0;}
    const jitter = ((h % 1000) / 1000) * 60;
    let best: ConquestNode | null = null;
    let bestScore = Infinity;
    for (const n of this.nodes) {
      const foeOnIt = (this.presence.get(n.id)?.[foe] ?? 0) > 0;
      // Defense outranks frontier expansion — a contested owned node
      // gets a distance discount so nearby bots peel back to it.
      const defend = n.owner === me && foeOnIt;
      // Neutral + linked → build target; enemy + linked → raze target.
      const attack = n.owner !== me && conquestActionable(this.nodes, n, me, this.n);
      if (!defend && !attack) {continue;}
      const d = Math.hypot(n.pos.x - p.position.x, n.pos.z - p.position.z) + jitter - (defend ? 80 : 0);
      if (d < bestScore) { bestScore = d; best = n; }
    }
    if (!best) {return null;}
    return { pos: { x: best.pos.x, y: best.pos.y, z: best.pos.z }, infiltrating: best.owner !== me };
  }

  /** Bodies inside each node's touch ring — 2D ring + a vertical slack
   *  band so a flyer 10m over the pad isn't "on" it. 20Hz × 25 nodes ×
   *  roster is cheap; no swept-touch needed at ski speeds (2m/tick). */
  private scanPresence(): void {
    this.presence.clear();
    const r2 = CONQUEST.TOUCH_R * CONQUEST.TOUCH_R;
    for (const p of this.room.players.getAllPlayers().values()) {
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
    this.scanPresence();
    for (const n of this.nodes) {
      const pr = this.presence.get(n.id)!;
      if (n.owner === 'neutral') {this.tickNeutral(n, pr, dt);}
      else if (n.core) {this.tickOwned(n, pr, dt, CONQUEST.CORE_RAZE_S, true);}
      else {this.tickOwned(n, pr, dt, CONQUEST.RAZE_S, false);}
    }
    if (this.dirty) {
      this.dirty = false;
      this.room.broadcast({ type: 'nodeUpdate', nodes: this.snapshot() } as ServerMessage);
    }
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
  private applyBlast(pos: Vec3, damage: number, radius: number, shooterId: string, scales?: readonly number[]): void {
    const team = this.room.players.getPlayer(shooterId)?.team;
    if (team !== 'alpha' && team !== 'bravo') {return;}
    for (const n of this.nodes) {
      const dist = Math.hypot(n.pos.x - pos.x, n.pos.y - pos.y, n.pos.z - pos.z);
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
    this.room.influence.splat(n.pos, 'opportunity', 1);
    logger.info('Node captured', { room: this.room.name, node: n.id, by: team });
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
    this.room.influence.splat(n.pos, 'opportunity', 1);
    logger.info('Node razed', { room: this.room.name, node: n.id });
    this.syncSpawns();
    this.syncScores();
    this.dirty = true;
  }

  private coreDown(n: ConquestNode, attacker: TeamId): void {
    n.hp = 0;
    this.dirty = true;
    logger.info('Core destroyed', { room: this.room.name, node: n.id, by: attacker });
    this.room.endMatch(attacker);
  }

  /** Match boundary — endCleanup's reset funnel lands here; a fresh
   *  match re-mints the lattice (positions identical, state clean). */
  reset(): void {
    this.layout();
  }

  /** Spec rotation — the lattice re-derives on the new span/field. */
  onSpec(_spec: MapSpec): void {
    this.layout();
  }

  /** Live terrain (re)attach — re-snap heights, keep the ownership map. */
  onTerrain(): void {
    for (const n of this.nodes) {n.pos.y = this.groundAt(n.pos.x, n.pos.z);}
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

