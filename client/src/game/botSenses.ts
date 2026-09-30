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
import { losClear, type BrainCtx } from '../../../shared/botBrain.js';
import type { GameBot } from './botBrain.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from '../entities/balls.js';

export interface SenseHost {
  readonly bots: GameBot[];
  /** 'local' + bot:names → team key. */
  readonly teamOf: Map<string, string>;
  player(): { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloaked: boolean };
  world(): { remotePlayers: Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean }>;
             explosions: { pos: THREE.Vector3; age: number }[];
             projectiles: { pos: THREE.Vector3; vel: THREE.Vector3 }[] };
  /** Active mode id — farming modes extend the creature sense range. */
  mode(): string;
  nearestCreature(pos: THREE.Vector3, maxDist: number): Targetable | null;
}

export type FoeEntry = { id: string; pos: THREE.Vector3; alive: boolean };
export type EnemyEntry = { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };
type BotEntry = { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };

// Scratch BrainCtx for losClear — fields it doesn't read stay unset.
const _losCtx: BrainCtx = { pos: { x: 0, y: 0, z: 0 }, enemies: [], groundY: () => 0, now: 0 };
const _enemies: EnemyEntry[] = [];

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
    for (const e of this.host.world().explosions) {
      if (e.age > 1.5) continue;
      const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y, dz = e.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz < 50 * 50) out.push({ x: e.pos.x, y: e.pos.y, z: e.pos.z });
    }
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
      out.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
    return out;
  }

  /** Everything the bot may legally shoot: enemy-team players (the local
   *  player included) and hostile creatures. */
  enemyList(bot: GameBot): EnemyEntry[] {
    _enemies.length = 0;
    const player = this.host.player();
    if (this.host.teamOf.get('local') !== bot.team) {
      _enemies.push({ id: 'local', pos: player.pos, vel: player.vel, alive: !player.isDead && !player.isCloaked });
    }
    for (const [id, rp] of this.host.world().remotePlayers) {
      if (id === bot.playerId) continue;
      const team = this.host.teamOf.get(id);
      if (team === bot.team) continue;
      // A held cloak removes the bot from enemy senses — same rule the
      // local player's cloak enjoys in this list.
      _enemies.push({ id, pos: rp.pos, vel: rp.vel, alive: !rp.isDead && !rp.isCloakHidden });
    }
    // Farming modes look farther — the brain prefers beast targets
    // when huntCreatures is on, so a far beast still enters the list.
    const c = this.host.nearestCreature(bot.position, this.host.mode() === 'nuggets' ? 80 : 35);
    if (c) _enemies.push({ id: `creature:${c.id}`, pos: c.pos, vel: c.vel, alive: !c.dead });
    return _enemies;
  }

  /** Any living PLAYER foe in brawl range with a clear eye line?
   *  Creatures don't count — walking past wildlife isn't fear. Mirrors
   *  ServerBots.markFoeNear: the same visible-enemy evidence the server
   *  meter charges on. */
  foeSeen(bot: GameBot, foes: FoeEntry[], terrain: Terrain): boolean {
    for (const e of foes) {
      if (!e.alive || e.id.startsWith('creature:')) continue;
      if (e.pos.distanceTo(bot.position) >= 45) continue; // brawl range — server mirror
      _losCtx.groundY = (x, z) => terrain.getHeight(x, z);
      _losCtx.now = performance.now();
      if (losClear(_losCtx, bot.position, e.pos)) return true;
    }
    return false;
  }
}
