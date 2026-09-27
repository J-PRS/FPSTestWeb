import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { TEAM_COLORS, TEAM_LABEL, FLAG_PICKUP_R, FLAG_HOME_R, FLAG_RESET_S, bank, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import * as sfx from '../core/sfx.js';

export interface Flag {
  mesh: THREE.Group; home: THREE.Vector3; pos: THREE.Vector3;
  state: 'home' | 'carried' | 'dropped'; carrier: string | null; dropT: number;
}

export interface FlagCtx {
  lazyTerrain(): Terrain;
  lazyScene(): THREE.Scene;
  /** id → pos for 'local' and bot playerIds; null when dead. */
  carrierPos(id: string): THREE.Vector3 | null;
  teamOf(id: string): string | undefined;
  /** Living toucher candidates: [id, pos] pairs incl. the local player. */
  touchers(): [string, THREE.Vector3][];
  bots: GameBot[];
  scores: TeamScores;
  /** Capture landed — the referee pushes the HUD score. */
  onCapture(team: TeamId): void;
  onFeed(text: string): void;
}

const FLAG_POLE_GEO = new THREE.CylinderGeometry(0.06, 0.08, 4, 6);
const FLAG_POLE_MAT = new THREE.MeshBasicMaterial({ color: 0x888888 });
const FLAG_BANNER_GEO = new THREE.ConeGeometry(0.5, 1.2, 4);

/**
 * CTF flag entities — a pole + banner at each base, carried above a head,
 * dropped on death, returned on own-team touch. All mode rules live here;
 * TeamBots only bridges it to the roster/score.
 */
export class CtfFlags {
  private flags: Map<TeamId, Flag> = new Map();

  constructor(private ctx: FlagCtx, around: THREE.Vector3) {
    // Bases sit on the X axis around the player spawn — readable landmarks.
    const terrain = ctx.lazyTerrain();
    for (const team of ['alpha', 'bravo'] as TeamId[]) {
      const sign = team === 'alpha' ? -1 : 1;
      const home = new THREE.Vector3(around.x + sign * 70, 0, around.z);
      home.y = terrain.getHeight(home.x, home.z);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(FLAG_POLE_GEO, FLAG_POLE_MAT);
      const banner = new THREE.Mesh(FLAG_BANNER_GEO, new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] }));
      banner.position.set(0.55, 3.4, 0);
      pole.position.y = 2;
      g.add(pole, banner);
      g.position.copy(home);
      ctx.lazyScene().add(g);
      this.flags.set(team, { mesh: g, home, pos: home.clone(), state: 'home', carrier: null, dropT: 0 });
    }
  }

  /** Where a flag-focused bot should run: carrying → own base; enemy flag
   *  reachable → the flag; own flag dropped → touch it home. */
  objectiveFor(bot: GameBot): THREE.Vector3 | null {
    const enemyTeam: TeamId = bot.team === 'alpha' ? 'bravo' : 'alpha';
    const enemy = this.flags.get(enemyTeam);
    const own = this.flags.get(bot.team as TeamId);
    if (!enemy || !own) return null;
    if (bot.carryingFlag) return own.home;
    if (own.state === 'dropped') return own.pos; // touch it to send it home
    if (enemy.state !== 'carried') return enemy.pos;
    return own.home; // enemy flag is moving — escort/intercept toward home
  }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    for (const f of this.flags.values()) {
      if (f.carrier !== carrierId) continue;
      f.carrier = null;
      f.state = 'dropped';
      f.pos.copy(at);
      f.pos.y = this.ctx.lazyTerrain().getHeight(at.x, at.z);
      f.dropT = FLAG_RESET_S;
      const bot = this.ctx.bots.find(b => b.playerId === carrierId);
      if (bot) bot.carryingFlag = false;
    }
  }

  /** Match reset — every flag home, nobody carrying. */
  reset(): void {
    for (const f of this.flags.values()) {
      f.state = 'home'; f.carrier = null; f.pos.copy(f.home); f.mesh.position.copy(f.home);
    }
  }

  update(dt: number): void {
    const ctx = this.ctx;
    for (const [team, f] of this.flags) {
      if (f.state === 'carried') {
        const cp = f.carrier ? ctx.carrierPos(f.carrier) : null;
        if (!cp) { f.carrier = null; f.state = 'dropped'; f.dropT = FLAG_RESET_S; continue; }
        f.pos.set(cp.x, cp.y + 1.2, cp.z); // rides above the carrier's head
        // Capture: carrier inside own base ring (flag is the ENEMY's flag
        // owned by the carrier's opposing team — carrier's own base hosts it)
        const carrierTeam = ctx.teamOf(f.carrier!) as TeamId;
        if (carrierTeam !== team) {
          const ownBase = this.flags.get(carrierTeam)!;
          if (ownBase.state === 'home' && cp.distanceTo(ownBase.home) < FLAG_HOME_R) {
            bank(ctx.scores, carrierTeam);
            ctx.onCapture(carrierTeam);
            ctx.onFeed(`${f.carrier === 'local' ? 'YOU' : f.carrier!.replace('bot:', '')} captured the ${TEAM_LABEL[team]} flag!`);
            if (f.carrier === 'local') sfx.pickup();
            const bot = ctx.bots.find(b => b.playerId === f.carrier);
            if (bot) bot.carryingFlag = false;
            f.carrier = null; f.state = 'home'; f.pos.copy(f.home);
          }
        }
      } else if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) { f.state = 'home'; f.pos.copy(f.home); }
      }
      // Touch rules: enemy team grabs it, own team returns a dropped flag.
      if (f.state === 'carried') { f.mesh.position.copy(f.pos); continue; }
      for (const [id, tp] of ctx.touchers()) {
        const tTeam = ctx.teamOf(id);
        if (tp.distanceTo(f.pos) > FLAG_PICKUP_R) continue;
        if (f.state === 'dropped' && tTeam === team) {
          f.state = 'home'; f.pos.copy(f.home); // returned on touch
          break;
        }
        if (tTeam !== team) {
          f.state = 'carried'; f.carrier = id;
          const bot = ctx.bots.find(b => b.playerId === id);
          if (bot) bot.carryingFlag = true;
          ctx.onFeed(`${id === 'local' ? 'YOU' : id.replace('bot:', '')} took the ${TEAM_LABEL[team]} flag!`);
          break;
        }
      }
      f.mesh.position.copy(f.pos);
    }
  }
}
