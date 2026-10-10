/**
 * BotSenses — the read-only perception helpers TeamBots hands its bots:
 * who's hostile to whom (enemyBotsFor*), what the bot can hear
 * (recentNoises), what's flying at it (incomingNear), and whether a
 * specific foe is actually visible (foeSeen — LOS + range, the sheep
 * meter's evidence line). No mutation, no ticks — pure reads over
 * world/team state, mirrored against ServerBots' senses so offline and
 * wire bots see with the same eyes.
 */

import type * as THREE from 'three';
import { losClear, BRAWL_RANGE, FOE_CONE_MIN_DOT, type BrainCtx } from '../../../shared/botBrain.js';
import { classCapsule } from '../../../shared/botClasses.js';
import { shootRevealed } from '../../../shared/status.js';
import { NOISE_TTL_MS } from '../../../shared/wire.js';
import type { GameBot } from './botBrain.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from '../entities/balls.js';

export interface SenseHost {
  readonly bots: GameBot[];
  /** 'local' + bot:names → team key. */
  readonly teamOf: Map<string, string>;
  player(): { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloaked: boolean; lastFireAt: number; appliedClass?: string; health: number; maxHealth: number };
  world(): { remotePlayers: Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; ghostT: number; armorClass?: string; botHp?: number; botMaxHp?: number }>;
             explosions: { pos: THREE.Vector3; age: number }[];
             projectiles: { pos: THREE.Vector3; vel: THREE.Vector3 }[] };
  /** Active mode id — farming modes extend the creature sense range. */
  mode(): string;
  /** Shootable-world roster — creature enemies come from this, the same
   *  unfiltered bodies channel the server parties feed. */
  readonly targets: Targetable[];
}

export type FoeEntry = { id: string; pos: THREE.Vector3; alive: boolean };
export type EnemyEntry = { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; aimY?: number; hpFrac?: number };
type BotEntry = { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };

// Scratch BrainCtx for losClear — fields it doesn't read stay unset.
const _losCtx: BrainCtx = { pos: { x: 0, y: 0, z: 0 }, enemies: [], groundY: () => 0, now: 0 };
const _enemies: EnemyEntry[] = [];
// Pooled plain-vec + entry scratches: the lists below are consumed
// synchronously by the bot's think(), so the same entries can be
// rewritten on the next call instead of reallocated.
const _vecPool: { x: number; y: number; z: number }[] = [];
let _vecUsed = 0;
function nextVec(): { x: number; y: number; z: number } {
  const v = _vecPool[_vecUsed] ?? (_vecPool[_vecUsed] = { x: 0, y: 0, z: 0 });
  _vecUsed++;
  return v;
}
const _botPool: (BotEntry & { id?: string })[] = [];
let _botUsed = 0;
function nextBot(): BotEntry & { id?: string } {
  const b = _botPool[_botUsed] ?? (_botPool[_botUsed] = { playerId: '', pos: null as never, vel: null as never, alive: false });
  _botUsed++;
  return b;
}

export class BotSenses {
  constructor(private host: SenseHost) {}
  // Pooled foe list — deployable scans call this per item per tick and
  // every consumer (foesFor, rocket fan, some()) reads it synchronously
  // before the next call, so the same entries can be rewritten.
  private readonly _foePool: BotEntry[] = [];
  private readonly _foeOut: BotEntry[] = [];
  private nextFoe(i: number): BotEntry {
    const e = this._foePool[i] ?? (this._foePool[i] = { playerId: '', pos: null as never, vel: null as never, alive: false });
    this._foeOut[i] = e;
    return e;
  }

  enemyBotsForLocal(): BotEntry[] {
    const myTeam = this.host.teamOf.get('local');
    let n = 0;
    for (const b of this.host.bots) {
      if (b.isDead || b.team === myTeam) {continue;}
      const e = this.nextFoe(n++);
      e.playerId = b.playerId; e.pos = b.pos; e.vel = b.vel; e.alive = true;
    }
    this._foeOut.length = n;
    return this._foeOut;
  }

  /** Players hostile to a GIVEN team — a bot-owned turret/mine scans
   *  these: enemy bots AND the local player when they're on the other
   *  side. FFA makes everyone a foe of everyone. */
  enemyBotsForTeam(team: string): BotEntry[] {
    let n = 0;
    const player = this.host.player();
    if (this.host.teamOf.get('local') !== team) {
      const e = this.nextFoe(n++);
      e.playerId = 'local'; e.pos = player.pos; e.vel = player.vel;
      e.alive = !player.isDead && (!player.isCloaked || shootRevealed(player.lastFireAt, performance.now()));
    }
    for (const b of this.host.bots) {
      if (b.team === team) {continue;}
      const e = this.nextFoe(n++);
      e.playerId = b.playerId; e.pos = b.pos; e.vel = b.vel;
      e.alive = !b.isDead && (!b.isCloakHidden || b.ghostT > 0);
    }
    this._foeOut.length = n;
    return this._foeOut;
  }

  /** Blasts inside the noise ring's TTL — mirrors Room.noisesNear
   *  (50m radius). Gunshots stay unheard, same as the server. */
  recentNoises(pos: THREE.Vector3): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const e of this.host.world().explosions) {
      if (e.age > NOISE_TTL_MS / 1000) {continue;}
      const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y, dz = e.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz < 50 * 50) {
        const v = nextVec();
        v.x = e.pos.x; v.y = e.pos.y; v.z = e.pos.z;
        out.push(v);
      }
    }
    // _vecUsed is NOT rewound here — incomingNear runs right after and
    // must land in fresh slots, else it overwrites these entries while
    // ctx.sounds still references them.
    return out;
  }

  /** Shells inside 12m closing on the bot — mirrors RoomProjectiles
   *  .incomingNear: a round flying away is no threat at any distance. */
  incomingNear(pos: THREE.Vector3): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const p of this.host.world().projectiles) {
      const dx = pos.x - p.pos.x, dy = pos.y - p.pos.y, dz = pos.z - p.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 12) {continue;}
      if (p.vel.x * dx + p.vel.y * dy + p.vel.z * dz <= 0) {continue;}
      const v = nextVec();
      v.x = p.pos.x; v.y = p.pos.y; v.z = p.pos.z;
      out.push(v);
    }
    return out;
  }

  /** Everything the bot may legally shoot: enemy-team players (the local
   *  player included) and hostile creatures. */
  enemyList(bot: GameBot): EnemyEntry[] {
    _enemies.length = 0;
    _vecUsed = 0; _botUsed = 0;
    const player = this.host.player();
    if (this.host.teamOf.get('local') !== bot.team) {
      const e = nextBot() as EnemyEntry & { playerId?: string };
      e.id = 'local'; e.pos = player.pos; e.vel = player.vel; e.alive = !player.isDead && (!player.isCloaked || shootRevealed(player.lastFireAt, performance.now()));
      e.aimY = classCapsule(player.appliedClass).centerOff;
      e.hpFrac = player.maxHealth > 0 ? player.health / player.maxHealth : undefined;
      _enemies.push(e);
    }
    for (const [id, rp] of this.host.world().remotePlayers) {
      if (id === bot.playerId) {continue;}
      const team = this.host.teamOf.get(id);
      if (team === bot.team) {continue;}
      // A held cloak removes the bot from enemy senses — same rule the
      // local player's cloak enjoys in this list. A shimmer reveal
      // (ghostT from his own shot) unmasks him for its remainder.
      const e = nextBot() as EnemyEntry & { playerId?: string };
      e.id = id; e.pos = rp.pos; e.vel = rp.vel; e.alive = !rp.isDead && (!rp.isCloakHidden || rp.ghostT > 0);
      e.aimY = classCapsule(rp.armorClass).centerOff;
      // Wounded readout — the brain's burst-orbit pick prices the hp
      // left on the target; wire remotes carry no tank and stay
      // undefined (server marks them the same way).
      e.hpFrac = rp.botHp !== undefined ? rp.botHp / (rp.botMaxHp ?? 1) : undefined;
      _enemies.push(e);
    }
    // Every live scored creature enters — the server parties feed the
    // whole bodies roster unfiltered, so a far beast competes with a
    // near one for the same pick instead of nearest-only winning by
    // list position. Scoreless decor stays out (server's roster is
    // pops-declared creatures only).
    for (const t of this.host.targets) {
      if (t.dead || t.scoreless) {continue;}
      const e = nextBot() as EnemyEntry & { playerId?: string };
      e.id = `creature:${t.id}`; e.pos = t.pos; e.vel = t.vel; e.alive = true; e.aimY = 0;
      _enemies.push(e);
    }
    return _enemies;
  }

  // Sheep-meter cache: the ignore watchdog doesn't need per-frame LOS
  // truth — ~200ms staleness is invisible to a 3s recency window, and
  // foeSeen was one raycast per foe per bot per frame.
  private foeSeenCache = new Map<string, { t: number; v: boolean }>();

  /** Jersey swap — carry the 200ms 'recently seen' window so a defector
   *  doesn't instantly re-see (or re-miss) foes under the new id. */
  rekey(oldId: string, newId: string): void {
    const v = this.foeSeenCache.get(oldId);
    this.foeSeenCache.delete(oldId);
    if (v !== undefined) {this.foeSeenCache.set(newId, v);}
  }

  /** Any living PLAYER foe in brawl range with a clear eye line?
   *  Creatures don't count — walking past wildlife isn't fear. Mirrors
   *  ServerBots.markFoeNear: the same visible-enemy evidence the server
   *  meter charges on. */
  foeSeen(bot: GameBot, foes: FoeEntry[], terrain: Terrain): boolean {
    const now = performance.now();
    const hit = this.foeSeenCache.get(bot.playerId);
    if (hit && now - hit.t < 200) {return hit.v;}
    let v = false;
    const fx = Math.sin(bot.rotation.yaw), fz = Math.cos(bot.rotation.yaw);
    for (const e of foes) {
      if (!e.alive || e.id.startsWith('creature:')) {continue;}
      if (e.pos.distanceTo(bot.position) >= BRAWL_RANGE) {continue;} // brawl range — server mirror
      // The wire senses only count a foe inside the ~113° view cone —
      // charging a bot for "ignoring" an enemy behind it was the drift.
      const dx = e.pos.x - bot.position.x, dz = e.pos.z - bot.position.z;
      const gd = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / gd < FOE_CONE_MIN_DOT) {continue;}
      _losCtx.groundY = (x, z) => terrain.getHeight(x, z);
      _losCtx.now = now;
      _losCtx.team = bot.team === 'ffa' ? undefined : bot.team;
      if (losClear(_losCtx, bot.position, e.pos)) { v = true; break; }
    }
    this.foeSeenCache.set(bot.playerId, { t: now, v });
    return v;
  }
}
