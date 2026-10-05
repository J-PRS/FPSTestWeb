/**
 * ServerParties — one roster snapshot per sim tick, shared by every bot
 * think staggered into that tick, plus a coarse spatial grid so each
 * think's sense lists (enemies/allies/others) only iterate bodies inside
 * the legal sight domain. A 200-bot room used to pay O(bots × players)
 * of roster filtering per tick; now it's O(players) once plus O(nearby)
 * per think. The candidate sets are unchanged — nothing past the sight
 * domain could pass the acquisition range gate anyway, so dropping it
 * from the scan loses no information a bot could legally act on.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import type { BotEnemy } from '../../shared/botBrain.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { simNow } from './simClock.ts';
import type { PickupKind } from '../../shared/pickups.ts';

const CELL_M = 64;
/** Covers SIGHT_M (300) + margin: past this a hostile can never enter
 *  the eye-line scan, so the distance check alone isn't worth the row. */
const DOMAIN_M = 320;
const DOMAIN_R2 = DOMAIN_M * DOMAIN_M;
const CELL_BIAS = 256; // grid keys assume cells within ±256 (64m cells → ±16km)

type Row = { id: string; pos: Vec3; vel: Vec3; team?: string; dead: boolean; cloaked: boolean; aimY: number; en: BotEnemy };
export type Parties = { enemies: BotEnemy[]; allies: Vec3[]; others: Vec3[]; roster: { id: string; pos: Vec3; team?: string }[] };

const cellKey = (cx: number, cz: number) => ((cx + CELL_BIAS) << 16) | (cz + CELL_BIAS);

export class ServerParties {
  constructor(private readonly room: Room) {}

  private seq = -1;
  private players: Row[] = [];
  bodies: BotEnemy[] = [];
  /** Full live roster — flagGoal/standThreat reason globally (a threat
   *  on the stand matters wherever the thinker stands), so this list
   *  is NOT domain-limited. */
  roster: { id: string; pos: Vec3; team?: string }[] = [];
  pickups: { id: number; pos: Vec3; kind: PickupKind }[] = [];
  /** ally/body channels stay global like roster — every consumer
   *  (rally fold, retreat fold) picks the nearest live point and
   *  excludes self by the d>4 minimum, so the shared list is
   *  semantically identical to the old per-think filtered one. */
  othersAll: Vec3[] = [];
  alliesByTeam = new Map<string, Vec3[]>();
  private grid = new Map<number, number[]>();

  /** Positions are live refs, so the cached lists stay correct within
   *  the tick. Keyed on simNow, not tickSeq — bots think at their own
   *  cadence and scenario steps advance simNow without bumping tickSeq. */
  tick(): this {
    if (this.seq === simNow()) return this;
    this.seq = simNow();
    this.players.length = 0; this.bodies.length = 0; this.roster.length = 0; this.pickups.length = 0;
    this.othersAll.length = 0; this.alliesByTeam.clear(); this.grid.clear();
    for (const q of this.room.players.getAllPlayers().values()) {
      this.players.push({ id: q.id, pos: q.position, vel: q.velocity, team: q.team, dead: q.isDead, cloaked: !!(q.status & STATUS.CLOAK) && !shootRevealed(q.lastFireSim, this.seq), aimY: classCapsule(q.armorClass).centerOff,
        en: { id: q.id, pos: q.position, vel: q.velocity, alive: true, aimY: classCapsule(q.armorClass).centerOff } });
      if (!q.isDead) {
        this.roster.push({ id: q.id, pos: q.position, team: q.team });
        this.othersAll.push(q.position);
        if (q.team) {
          const list = this.alliesByTeam.get(q.team);
          if (list) list.push(q.position);
          else this.alliesByTeam.set(q.team, [q.position]);
        }
      }
      const k = cellKey(Math.floor(q.position.x / CELL_M), Math.floor(q.position.z / CELL_M));
      const cell = this.grid.get(k);
      if (cell) cell.push(this.players.length - 1);
      else this.grid.set(k, [this.players.length - 1]);
    }
    for (const b of this.room.ballSim.roster())
      this.bodies.push({ id: `b:${b.id}`, pos: b.position, vel: b.velocity, alive: true, aimY: 0 });
    for (const cr of this.room.creatureSim.roster())
      this.bodies.push({ id: `c:${cr.id}`, pos: cr.position, vel: cr.velocity, alive: true, aimY: 0 });
    // Pickups ride the same cache — gems only move on rare blast edges,
    // so per-step freshness matches every other channel here.
    const snaps = this.room.pickups?.snapshot();
    if (snaps) for (const g of snaps) this.pickups.push(g);
    return this;
  }

  /** One think's roster view — only `enemies` is domain-limited (the
   *  domain exceeds every acquisition gate, so the sets a think could
   *  legally engage are identical); allies/others stay global. */
  of(p: { id: string; team?: string; position: Vec3 }): Parties {
    const c = this.tick();
    const enemies: BotEnemy[] = [];
    const teams = !!this.room.modeSpec?.teams;
    const cx0 = Math.floor((p.position.x - DOMAIN_M) / CELL_M), cx1 = Math.floor((p.position.x + DOMAIN_M) / CELL_M);
    const cz0 = Math.floor((p.position.z - DOMAIN_M) / CELL_M), cz1 = Math.floor((p.position.z + DOMAIN_M) / CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = c.grid.get(cellKey(cx, cz));
        if (!cell) continue;
        for (const i of cell) {
          const q = c.players[i]!;
          if (q.id === p.id || q.dead || q.cloaked) continue;
          const dx = q.pos.x - p.position.x, dz = q.pos.z - p.position.z;
          if (dx * dx + dz * dz > DOMAIN_R2) continue;
          // Teamless modes are open season on every live body — bot or
          // human makes no difference to the gun.
          if (teams ? q.team !== p.team : true) enemies.push(q.en);
        }
      }
    }
    // Non-player bodies (balls/crawlers) ride ungridded — their counts
    // are small and their acquisition range is a separate gate.
    for (const b of c.bodies) enemies.push(b);
    return { enemies, allies: p.team ? (c.alliesByTeam.get(p.team) ?? []) : [], others: c.othersAll, roster: c.roster };
  }
}
