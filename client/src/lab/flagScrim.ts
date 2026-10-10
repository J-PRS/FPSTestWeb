/**
 * Flag scrim — 4v4 CTF: real BotBrain minds steered by the real role
 * table (assignRole → roleObjective, shared/flagGoals.ts). Flags run the
 * production touch/cap rules: PICKUP_R grab, HOME_R cap ring, RESET_S
 * dropped-flag walk home, death drops the flag where it fell. The chase
 * lead and the posted leash mirror botRouting's wiring, so what you
 * watch here is what the server bots do — minus the map.
 */
import * as THREE from 'three';
import { segPointDist } from '../../../shared/projSim.js';
import { hmHeight } from '../../../shared/heightfield.js';
import { GRAVITY } from '../../../shared/movement.js';
import type { BotVec } from '../../../shared/botBrain.js';
import { assignRole, roleObjective, WIRE_ROLES, type BotRole, type FlagSituation } from '../../../shared/flagGoals.js';
import { FLAG_HOME_R, FLAG_PICKUP_R, FLAG_RESET_S, TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { FLAG_STAND_LIFT } from '../../../shared/mapSpec.js';
import { BOT_TUNING } from '../../../shared/botTuning.js';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.js';
import { spawnShell, LAB_FLAT_FIELD, type LabWorld } from './simKit.js';
import type { LabInstance } from './scenarios.js';
import {
  BOT_ENERGY_MAX, BOT_HP, locomoteAgent, pickAtRange,
  respawnAgent, spawnAgent, type BotAgent,
} from './botAgents.js';

interface FlagBot extends BotAgent {
  team: TeamId;
  role: BotRole;
  cls: 'light' | 'medium' | 'heavy';
  carrying: LabFlag | null;
}

interface LabFlag {
  team: TeamId;
  home: { x: number; y: number; z: number };
  pos: { x: number; y: number; z: number };
  state: 'home' | 'carried' | 'dropped';
  carrier: FlagBot | null;
  dropT: number;
  mesh: THREE.Mesh;
  stand: THREE.Mesh;
}

type Pt = { x: number; y: number; z: number };

const near = (p: Pt, q: Pt, r: number): boolean =>
  Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < r;

function mkFlag(scene: THREE.Scene, team: TeamId, x: number): LabFlag {
  const home = { x, y: 0, z: 0 };
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7),
    new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] }),
  );
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.6, 0.5, 14),
    new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.35 }),
  );
  stand.position.set(x, 0, 0);
  scene.add(mesh, stand);
  return { team, home, pos: { x: home.x, y: home.y, z: home.z }, state: 'home', carrier: null, dropT: 0, mesh, stand };
}

/** A dropped flag sits where the carrier died until the reset timer
 *  walks it home — production FLAG_RESET_S rule. */
function dropFlag(f: LabFlag, pos: Pt): void {
  f.state = 'dropped';
  f.pos = { x: pos.x, y: pos.y, z: pos.z };
  f.carrier = null;
  f.dropT = FLAG_RESET_S;
}

/** Position + velocity snapshot the situation slots carry (thief/escort
 *  lead the run — chasing the raw position is wake-chasing). */
function carrierPos(c: FlagBot | null): (Pt & { vx: number; vz: number }) | null {
  if (!c) { return null; }
  const p = c.sim.state.pos, v = c.sim.state.vel;
  return { x: p.x, y: p.y, z: p.z, vx: v.x, vz: v.z };
}

/** Squad roster: one heavy (HoF candidate), a medium, the rest lights —
 *  the kit pull that CLASS_FITNESS reads in production assignment. */
const CLASSES: FlagBot['cls'][] = ['heavy', 'medium', 'light', 'light'];

function spawnSquad(scene: THREE.Scene, team: TeamId, bots: FlagBot[]): void {
  const side = team === 'alpha' ? -1 : 1;
  for (let i = 0; i < CLASSES.length; i += 1) {
    const lo = BOT_LOADOUTS[i] as (typeof BOT_LOADOUTS)[number];
    const base = spawnAgent(scene, `${team}${i}`, TEAM_COLORS[team], side * 45, lo);
    const bot: FlagBot = Object.assign(base, { team, cls: CLASSES[i], carrying: null, role: 'offense' as BotRole });
    bot.sim.setState({
      pos: { x: side * 45, y: 2, z: -12 + i * 8 },
      vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: false,
    });
    bots.push(bot);
  }
  const ids = bots.filter(b => b.team === team).map(b => b.name);
  for (const bot of bots.filter(b => b.team === team)) {
    bot.role = assignRole(bot.name, ids, WIRE_ROLES, id => bots.find(o => o.name === id)?.cls);
  }
}

/** The live flag picture one bot sees — same slots botRouting fills:
 *  thief beacon (velocity rides for aim lead), dropped, enemy stand
 *  lifted to deck height, escort, home-side threat. */
function flagSituation(a: FlagBot, flags: Record<TeamId, LabFlag>, foes: FlagBot[]): FlagSituation {
  const own = flags[a.team];
  const enemy = flags[a.team === 'alpha' ? 'bravo' : 'alpha'];
  let threat: FlagBot | null = null;
  let bd = 45;
  for (const foe of foes) {
    if (foe.dead > 0) { continue; }
    const d = Math.hypot(foe.sim.state.pos.x - own.home.x, foe.sim.state.pos.z - own.home.z);
    if (d < bd) { bd = d; threat = foe; }
  }
  let enemyStand: Pt | null = null;
  if (enemy.state === 'home') {
    enemyStand = { x: enemy.pos.x, y: enemy.pos.y + FLAG_STAND_LIFT, z: enemy.pos.z };
  } else if (enemy.state === 'dropped') {
    enemyStand = enemy.pos;
  }
  return {
    home: own.home,
    thief: carrierPos(own.state === 'carried' ? own.carrier : null),
    dropped: own.state === 'dropped' ? own.pos : null,
    enemyStand,
    escort: carrierPos(enemy.state === 'carried' ? enemy.carrier : null),
    threat: threat ? { x: threat.sim.state.pos.x, y: threat.sim.state.pos.y, z: threat.sim.state.pos.z } : null,
    me: { x: a.sim.state.pos.x, z: a.sim.state.pos.z },
  };
}

/** The bot's committed destination for this tick, with the runner flag.
 *  Carriers run home; everyone else follows the role table, with the
 *  production ETA-lead on chase/escort picks so pursuers intercept the
 *  run instead of the wake. */
function objectiveFor(a: FlagBot, flags: Record<TeamId, LabFlag>, foes: FlagBot[]): { objective: BotVec; runner: boolean; posted: number } {
  const own = flags[a.team];
  if (a.carrying) {
    return { objective: own.home, runner: true, posted: 0 };
  }
  const sit = flagSituation(a, flags, foes);
  let pick = roleObjective(a.role, sit, a.brain.dutyLevel);
  let lead = null;
  if (pick === sit.escort) { lead = sit.escort; }
  else if (pick === sit.thief) { lead = sit.thief; }
  if (lead) {
    const s = a.sim.state.pos;
    const eta = Math.min(10, Math.hypot(lead.x - s.x, lead.z - s.z) / 24);
    pick = { x: lead.x + (lead.vx ?? 0) * eta, y: lead.y, z: lead.z + (lead.vz ?? 0) * eta };
  }
  // Posted leash for anchored roles — botRouting's duty-scaled base,
  // widened once the home flag is out so the defense roams the counter.
  const anchored = a.role === 'hof' || a.role === 'ldefense' || a.role === 'defense';
  let posted = 0;
  if (anchored && Math.hypot(pick.x - own.home.x, pick.z - own.home.z) < 15) {
    const carriedBase = a.role === 'hof' ? BOT_TUNING.hof.postCarried : 200;
    const homeBase = a.role === 'hof' ? BOT_TUNING.hof.postHome : 90;
    posted = (own.state === 'carried' ? carriedBase : homeBase) * (1.35 - 0.5 * a.brain.dutyLevel);
  }
  return { objective: pick, runner: a.role === 'capper', posted };
}

/** Combat + cognition half of the scrim: shells fly the real visual
 *  stack, brains think with the real sense stack, kills drop the flag.
 *  Owns its ms clock so think() sees the same `now` channel the host
 *  feeds (BotBrain's senses time-stamp against it). */
function mkCombat(world: LabWorld, bots: FlagBot[], flags: Record<TeamId, LabFlag>, counters: { deaths: number }): {
  shells: (ReturnType<typeof spawnShell> & { from: FlagBot })[];
  thinkOne: (a: FlagBot) => void;
  tick: (dt: number) => void;
  dispose: () => void;
} {
  const shells: (ReturnType<typeof spawnShell> & { from: FlagBot })[] = [];
  let now = 0;

  /** Kill credit + flag drop when a shell connects with a live foe. */
  const applyHit = (foes: FlagBot[], impact: Pt, damage: number, fromPos: Pt): void => {
    for (const foe of foes) {
      if (foe.dead > 0) { continue; }
      const fp = foe.sim.state.pos;
      if (Math.hypot(impact.x - fp.x, impact.y - fp.y, impact.z - fp.z) > 1.6) { continue; }
      foe.hp -= damage;
      foe.brain.takeHit(fromPos);
      if (foe.hp <= 0) {
        foe.dead = 2.5;
        foe.hp = BOT_HP;
        foe.energy = BOT_ENERGY_MAX;
        foe.mesh.visible = false;
        counters.deaths += 1;
        if (foe.carrying) {
          dropFlag(foe.carrying, { x: fp.x, y: Math.max(0, fp.y - 1), z: fp.z });
          foe.carrying = null;
        }
      }
      return;
    }
  };

  const fire = (f: FlagBot, foes: FlagBot[], aim: BotVec): void => {
    const s = f.sim.state;
    const d = Math.hypot(aim.x - s.pos.x, aim.y - s.pos.y, aim.z - s.pos.z) || 1;
    const { st, wt } = pickAtRange(f, d);
    if (st.speed <= 0) { return; }
    const sh = spawnShell({
      weaponType: wt,
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: (aim.x - s.pos.x) / d * st.speed, y: (aim.y - s.pos.y) / d * st.speed, z: (aim.z - s.pos.z) / d * st.speed },
      gravity: st.gravity ? GRAVITY : 0,
      maxAge: 2.5,
      hitTest: (from, pos) => foes.some(foe => {
        if (foe.dead > 0) { return false; }
        const fp = foe.sim.state.pos;
        return segPointDist(from, pos, { x: fp.x, y: fp.y, z: fp.z }) < 1.4;
      }),
      onDone: (impact, directHit) => {
        if (directHit && impact) { applyHit(foes, impact, st.directDamage, s.pos); }
      },
    }, world) as ReturnType<typeof spawnShell> & { from: FlagBot };
    sh.from = f;
    shells.push(sh);
  };

  const thinkOne = (a: FlagBot): void => {
    const s = a.sim.state;
    const foes = bots.filter(b => b.team !== a.team);
    const mates = bots.filter(b => b.team === a.team && b !== a);
    const { objective, runner, posted } = objectiveFor(a, flags, foes);
    const out = a.brain.think(1 / 60, {
      pos: s.pos,
      vel: s.vel,
      enemies: foes.filter(f => f.dead <= 0)
        .map(f => ({ id: f.name, pos: f.sim.state.pos, vel: f.sim.state.vel, alive: true, aimY: -0.7 })),
      allies: mates.filter(m => m.dead <= 0).map(m => m.sim.state.pos),
      groundY: (x, z) => hmHeight(LAB_FLAT_FIELD, x, z),
      now,
      energy: a.energy,
      healthFrac: a.hp / BOT_HP,
      threats: shells.filter(sh => sh.from.team !== a.team).map(sh => sh.sim.pos),
      weaponSpeed: d => pickAtRange(a, d).st.speed,
      weaponGravity: d => pickAtRange(a, d).st.gravity,
      objective,
      runner,
      posted,
    });
    a.lastDest = out.dest;
    a.lastMove = out.move;
    if (out.fire) { fire(a, foes, out.fire.aim); }
  };

  const tick = (dt: number): void => {
    now += dt * 1000;
    for (let i = shells.length - 1; i >= 0; i -= 1) {
      const sh = shells[i];
      if (!sh) { continue; }
      sh.tick(dt, world);
      if (sh.done) { sh.dispose(); shells.splice(i, 1); }
    }
    for (let i = world.effects.length - 1; i >= 0; i -= 1) {
      const fx = world.effects[i];
      if (!fx) { continue; }
      fx.update(dt);
      if (fx.dead) { fx.dispose(); world.effects.splice(i, 1); }
    }
  };

  const dispose = (): void => {
    for (const sh of shells) { sh.dispose(); }
    for (const fx of world.effects) { fx.dispose(); }
    world.effects.length = 0;
  };

  return { shells, thinkOne, tick, dispose };
}

export function flagScrim(scene: THREE.Scene): LabInstance {
  const world: LabWorld = { scene, field: LAB_FLAT_FIELD, target: null, time: 0, effects: [] };
  const STAND_X = 55;
  const score = { alpha: 0, bravo: 0 };
  const counters = { grabs: 0, returns: 0, deaths: 0 };

  const flags: Record<TeamId, LabFlag> = {
    alpha: mkFlag(scene, 'alpha', -STAND_X),
    bravo: mkFlag(scene, 'bravo', STAND_X),
  };
  const bots: FlagBot[] = [];
  spawnSquad(scene, 'alpha', bots);
  spawnSquad(scene, 'bravo', bots);
  const combat = mkCombat(world, bots, flags, counters);

  /** Flag touches per live bot: enemy-flag grab, own-dropped return,
   *  cap on the home ring while our flag is planted. */
  const touchFlags = (a: FlagBot): void => {
    const own = flags[a.team];
    const enemy = flags[a.team === 'alpha' ? 'bravo' : 'alpha'];
    if (a.carrying) {
      if (own.state === 'home' && near(a.sim.state.pos, own.home, FLAG_HOME_R)) {
        score[a.team] += 1;
        const f = a.carrying;
        a.carrying = null;
        f.state = 'home';
        f.carrier = null;
        f.pos = { x: f.home.x, y: f.home.y, z: f.home.z };
      }
      return;
    }
    if (enemy.state !== 'carried' && near(a.sim.state.pos, enemy.pos, FLAG_PICKUP_R + 0.6)) {
      enemy.state = 'carried';
      enemy.carrier = a;
      a.carrying = enemy;
      counters.grabs += 1;
    } else if (own.state === 'dropped' && near(a.sim.state.pos, own.pos, FLAG_PICKUP_R)) {
      own.state = 'home';
      own.pos = { x: own.home.x, y: own.home.y, z: own.home.z };
      counters.returns += 1;
    }
  };

  /** Carried flags ride the carrier; dropped ones walk home on the
   *  production reset timer. */
  const tickFlags = (dt: number): void => {
    for (const f of [flags.alpha, flags.bravo]) {
      if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) {
          f.state = 'home';
          f.pos = { x: f.home.x, y: f.home.y, z: f.home.z };
        }
      }
      if (f.state === 'carried' && f.carrier) {
        const cp = f.carrier.sim.state.pos;
        f.pos = { x: cp.x, y: cp.y + 0.5, z: cp.z };
      }
    }
  };

  return {
    tick(dt) {
      world.time += dt;
      for (const a of bots) {
        if (a.dead > 0) {
          a.dead -= dt;
          if (a.dead <= 0) { respawnAgent(a, a.team === 'alpha' ? -45 : 45); }
          continue;
        }
        combat.thinkOne(a);
        locomoteAgent(a, dt);
        touchFlags(a);
      }
      tickFlags(dt);
      combat.tick(dt);
    },
    sync() {
      for (const a of bots) {
        a.mesh.position.set(a.sim.state.pos.x, a.sim.state.pos.y - 1.5, a.sim.state.pos.z);
        a.mesh.rotation.y = a.yaw;
      }
      for (const f of [flags.alpha, flags.bravo]) {
        f.mesh.position.set(f.pos.x, f.pos.y + FLAG_STAND_LIFT + 0.5, f.pos.z);
      }
      for (const sh of combat.shells) { sh.sync(); }
    },
    dump() {
      const rows: [string, string][] = [
        ['score a/b', `${score.alpha}/${score.bravo}`],
        ['flag alpha', flags.alpha.state + (flags.alpha.state === 'dropped' ? ` ${flags.alpha.dropT.toFixed(0)}s` : '')],
        ['flag bravo', flags.bravo.state + (flags.bravo.state === 'dropped' ? ` ${flags.bravo.dropT.toFixed(0)}s` : '')],
        ['grabs', String(counters.grabs)],
        ['returns', String(counters.returns)],
        ['deaths', String(counters.deaths)],
      ];
      for (const a of bots) {
        rows.push([a.name, `${a.role}${a.carrying ? '*' : ''} ${Math.max(0, a.hp).toFixed(0)}hp`]);
      }
      return rows;
    },
    dispose() {
      for (const a of bots) { scene.remove(a.mesh); a.mesh.geometry.dispose(); }
      for (const f of [flags.alpha, flags.bravo]) {
        scene.remove(f.mesh, f.stand);
        f.mesh.geometry.dispose();
        f.stand.geometry.dispose();
      }
      combat.dispose();
    },
  };
}
