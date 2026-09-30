/**
 * botCtf — the CTF bridge for TeamBots: flag-state lifecycle (CtfFlags
 * wiring), the per-frame marker draw, and the carrier/toucher/drop
 * helpers the flags module queries. TeamBots keeps score/match flow;
 * this owns the "flags see the roster" glue.
 */
import * as THREE from 'three';
import { CtfFlags } from './ctfFlags.js';
import { Explosion } from '../effects/explosion.js';
import { FLAG_PICKUP_R, TEAM_COLORS, type TeamId, type TeamScores } from '../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import * as sfx from '../core/sfx.js';

const _flagBurst = new THREE.Vector3();
const _touchers: [string, THREE.Vector3][] = [];

export interface CtfBridgeDeps {
  lazyTerrain(): import('../world/terrain.js').Terrain;
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyPlayer(): { pos: THREE.Vector3; isDead: boolean; mods: { pickupRadius: number } };
  lazyHud(): { updateFlagIndicator(id: string, pos: THREE.Vector3, cam: THREE.Camera, team: string): void };
  world: {
    remotePlayers: Map<string, { pos: THREE.Vector3; isDead: boolean }>;
    explosions: { push(e: Explosion): void };
  };
}

export interface CtfBridgeWiring {
  bots: GameBot[];
  teamOf: Map<string, string>;
  scores: TeamScores;
  playerTeam: TeamId;
  modsFor(id: string): { pickupRadius: number } | undefined;
  onCapture(team: TeamId): void;
  onFeed(t: string): void;
}

export class CtfBridge {
  private ctf: CtfFlags;

  constructor(private deps: CtfBridgeDeps, w: CtfBridgeWiring) {
    this.ctf = new CtfFlags({
      lazyTerrain: deps.lazyTerrain,
      lazyScene: deps.lazyScene,
      carrierPos: (id) => this.carrierPos(id),
      teamOf: (id) => w.teamOf.get(id),
      pickupRadiusOf: (id) => FLAG_PICKUP_R * (w.modsFor(id)?.pickupRadius ?? 1),
      touchers: () => this.touchers(w.bots),
      bots: w.bots,
      scores: w.scores,
      onCapture: (t) => w.onCapture(t),
      onFeed: (t) => w.onFeed(t),
      onFlagEvent: (kind, team, at) => {
        sfx.flagCue(kind, team === w.playerTeam);
        deps.world.explosions.push(new Explosion(
          deps.lazyScene(), _flagBurst.copy(at).setY(at.y + 1.2), false, 0,
          deps.lazyTerrain(), kind === 'captured' ? 2.4 : kind === 'dropped' ? 1.0 : 1.4,
          TEAM_COLORS[team]));
      },
    }, deps.lazyPlayer().pos);
  }

  /** Objective data the per-bot ctx asks for. */
  objectiveInfoFor(bot: GameBot) { return this.ctf.objectiveInfoFor(bot); }

  update(dt: number): void {
    this.ctf.update(dt);
    // Flag markers ride the player-indicator overlay — a DOM element
    // projects through terrain, which is the entire point.
    const cam = this.deps.lazyCamera();
    const hud = this.deps.lazyHud();
    for (const m of this.ctf.markers()) {
      // +3.4 → the indicator's own +1.0 puts the diamond at the 4m
      // pole tip instead of at the base's feet.
      m.pos.y += 3.4;
      hud.updateFlagIndicator(`flag:${m.team}`, m.pos, cam, m.team);
      m.pos.y -= 3.4;
    }
  }

  reset(): void { this.ctf.reset(); }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    this.ctf.dropCarried(carrierId, at);
  }

  private carrierPos(id: string): THREE.Vector3 | null {
    if (id === 'local') { const p = this.deps.lazyPlayer(); return p.isDead ? null : p.pos; }
    const rp = this.deps.world.remotePlayers.get(id);
    return rp && !rp.isDead ? rp.pos : null;
  }

  private touchers(bots: GameBot[]): [string, THREE.Vector3][] {
    const player = this.deps.lazyPlayer();
    _touchers.length = 0;
    if (!player.isDead) _touchers.push(['local', player.pos]);
    for (const b of bots) if (!b.isDead) _touchers.push([b.playerId, b.position]);
    return _touchers;
  }
}
