/**
 * BotSenses — the read-only perception helpers TeamBots hands its bots:
 * who's hostile to whom (enemyBotsFor*), what the bot can hear
 * (recentNoises), what's flying at it (incomingNear), and whether a
 * specific foe is actually visible (foeSeen — LOS + range, the sheep
 * meter's evidence line). No mutation, no ticks — pure reads over
 * world/team state, mirrored against ServerBots' senses so offline and
 * wire bots see with the same eyes.
 */

import * as THREE from 'three';
import { losClear, BRAWL_RANGE, FOE_CONE_MIN_DOT, type BrainCtx } from '../../../shared/botBrain.js';
import { classCapsule } from '../../../shared/botClasses.js';
import type { GameBot } from './botBrain.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from '../entities/balls.js';

export interface SenseHost {
  readonly bots: GameBot[];
  /** 'local' + bot:names → team key. */
  readonly teamOf: Map<string, string>;
  player(): { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloaked: boolean; appliedClass?: string };
  world(): { remotePlayers: Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; armorClass?: string }>;
             explosions: { pos: THREE.Vector3; age: number }[];
             projectiles: { pos: THREE.Vector3; vel: THREE.Vector3 }[] };
  /** Active mode id — farming modes extend the creature sense range. */
  mode(): string;
  nearestCreature(pos: THREE.Vector3, maxDist: number): Targetable | null;
}

export type FoeEntry = { id: string; pos: THREE.Vector3; alive: boolean };
export type EnemyEntry = { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; aimY?: number };
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

  enemyBotsForLocal(): BotEntry[] {
    const myTeam = this.host.teamOf.get('local');
    return this.host.bots
      .filter(b => !b.isDead && b.team !== myTeam)
      .map(b => ({ playerId: b.playerId, pos: b.pos, vel: b.vel, alive: true }));
  }

  /** Players hostile to a GIVEN team — a bot-owned turret/mine scans
   *  these: enemy bots AND the local player when they're on the other
   *  side. FFA makes everyone a foe of everyone. */
  enemyBotsForTeam(team: string): BotEntry[] {
    const out: BotEntry[] = [];
    const player = this.host.player();
    if (this.host.teamOf.get('local') !== team) {
      out.push({ playerId: 'local', pos: player.pos, vel: player.vel, alive: !player.isDead && !player.isCloaked });
    }
    for (const b of this.host.bots) {
      if (b.team === team) continue;
      out.push({ playerId: b.playerId, pos: b.pos, vel: b.vel, alive: !b.isDead && !b.isCloakHidden });
    }
    return out;
  }

  /** Blasts younger than ~1.5s inside earshot — mirrors Room.noisesNear
   *  (50m radius). Gunshots stay unheard, same as the server. */
  recentNoises(pos: THREE.Vector3): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    const vecBase = _vecUsed;
    for (const e of this.host.world().explosions) {
      if (e.age > 1.5) continue;
      const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y, dz = e.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz < 50 * 50) {
        const v = nextVec();
        v.x = e.pos.x; v.y = e.pos.y; v.z = e.pos.z;
        out.push(v);
      }
    }
    _vecUsed = vecBase; // out entries keep pool slots until the caller's next read
    return out;
  }

  /** Shells inside 12m closing on the bot — mirrors RoomProjectiles
   *  .incomingNear: a round flying away is no threat at any distance. */
  incomingNear(pos: THREE.Vector3): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const p of this.host.world().projectiles) {
      const dx = pos.x - p.pos.x, dy = pos.y - p.pos.y, dz = pos.z - p.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > 12) continue;
      if (p.vel.x * dx + p.vel.y * dy + p.vel.z * dz <= 0) continue;
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
      e.id = 'local'; e.pos = player.pos; e.vel = player.vel; e.alive = !player.isDead && !player.isCloaked;
      e.aimY = classCapsule(player.appliedClass).centerOff;
      _enemies.push(e);
    }
    for (const [id, rp] of this.host.world().remotePlayers) {
      if (id === bot.playerId) continue;
      const team = this.host.teamOf.get(id);
      if (team === bot.team) continue;
      // A held cloak removes the bot from enemy senses — same rule the
      // local player's cloak enjoys in this list.
      const e = nextBot() as EnemyEntry & { playerId?: string };
      e.id = id; e.pos = rp.pos; e.vel = rp.vel; e.alive = !rp.isDead && !rp.isCloakHidden;
      e.aimY = classCapsule(rp.armorClass).centerOff;
      _enemies.push(e);
    }
    // Farming modes look farther — the brain prefers beast targets
    // when huntCreatures is on, so a far beast still enters the list.
    const c = this.host.nearestCreature(bot.position, this.host.mode() === 'nuggets' ? 80 : 35);
    if (c) {
      const e = nextBot() as EnemyEntry & { playerId?: string };
      e.id = `creature:${c.id}`; e.pos = c.pos; e.vel = c.vel; e.alive = !c.dead; e.aimY = 0;
      _enemies.push(e);
    }
    return _enemies;
  }

  // Sheep-meter cache: the ignore watchdog doesn't need per-frame LOS
  // truth — ~200ms staleness is invisible to a 3s recency window, and
  // foeSeen was one raycast per foe per bot per frame.
  private foeSeenCache = new Map<string, { t: number; v: boolean }>();

  /** Any living PLAYER foe in brawl range with a clear eye line?
   *  Creatures don't count — walking past wildlife isn't fear. Mirrors
   *  ServerBots.markFoeNear: the same visible-enemy evidence the server
   *  meter charges on. */
  foeSeen(bot: GameBot, foes: FoeEntry[], terrain: Terrain): boolean {
    const now = performance.now();
    const hit = this.foeSeenCache.get(bot.playerId);
    if (hit && now - hit.t < 200) return hit.v;
    let v = false;
    const fx = Math.sin(bot.rotation.yaw), fz = Math.cos(bot.rotation.yaw);
    for (const e of foes) {
      if (!e.alive || e.id.startsWith('creature:')) continue;
      if (e.pos.distanceTo(bot.position) >= BRAWL_RANGE) continue; // brawl range — server mirror
      // The wire senses only count a foe inside the ~113° view cone —
      // charging a bot for "ignoring" an enemy behind it was the drift.
      const dx = e.pos.x - bot.position.x, dz = e.pos.z - bot.position.z;
      const gd = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / gd < FOE_CONE_MIN_DOT) continue;
      _losCtx.groundY = (x, z) => terrain.getHeight(x, z);
      _losCtx.now = now;
      if (losClear(_losCtx, bot.position, e.pos)) { v = true; break; }
    }
    this.foeSeenCache.set(bot.playerId, { t: now, v });
    return v;
  }
}
