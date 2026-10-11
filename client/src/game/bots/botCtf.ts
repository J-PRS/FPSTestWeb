/**
 * botCtf — the CTF bridge for TeamBots: flag-state lifecycle (CtfFlags
 * wiring), the per-frame marker draw, and the carrier/toucher/drop
 * helpers the flags module queries. TeamBots keeps score/match flow;
 * this owns the "flags see the roster" glue.
 */
import * as THREE from 'three';
import { CtfFlags } from '../ctfFlags.js';
import { Explosion } from '../../effects/explosion.js';
import { FLAG_PICKUP_R, TEAM_COLORS, type TeamId, type TeamScores } from '../../../../shared/teams.js';
import type { GameBot } from './botBrain.js';
import { applyStructureSpecs } from '../structureSpecs.js';
import type { StructureSpec } from '../../../../shared/mapSpec.js';
import { flagReturnFx } from '../flagFx.js';
import { FLAG_STAND_TOP } from '../../structures/structures.js';
import * as sfx from '../../core/sfx.js';

const _flagBurst = new THREE.Vector3();
const _touchers: [string, THREE.Vector3, THREE.Vector3][] = [];

export interface CtfBridgeDeps {
  lazyTerrain(): import('../../world/terrain.js').Terrain;
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyPlayer(): { pos: THREE.Vector3; isDead: boolean; mods: { pickupRadius: number };
    vel?: THREE.Vector3; yaw: number; pitch: number;
    movement?: { setStructures(l: readonly StructureSpec[] | undefined): void } };
  lazyHud(): { updateFlagIndicator(id: string, pos: THREE.Vector3, cam: THREE.Camera, team: string, kind?: 'flag' | 'stand'): void;
    removePlayerIndicator?(id: string): void };
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
  /** Personal-score payout — botMatch's awardPersonal. */
  onPersonalPoints?(id: string, pts: number): void;
  /** Flag edge → room chatter sense (the server's bots.notice mirror). */
  onFlagNotice?(kind: 'flaggrab' | 'flagcap' | 'flagreturn' | 'flagdrop', actorId: string, actorTeam?: string, at?: { x: number; y: number; z: number }): void;
  /** Authored base positions from a solo map spec — wins over the
   *  ±70m-around-player default when present. */
  bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } };
  /** The spec's structure list — stand hulls merge OVER it (the solid
   *  world is replaced wholesale, never appended). */
  structures?: import('../../../../shared/mapSpec.js').StructureSpec[];
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
      onPersonalPoints: (id, pts) => w.onPersonalPoints?.(id, pts),
      onFlagEvent: (kind, team, at, actor) => {
        const chatKind = { taken: 'flaggrab', dropped: 'flagdrop', returned: 'flagreturn', captured: 'flagcap' } as const;
        if (actor) w.onFlagNotice?.(chatKind[kind], actor.id, actor.team, at);
        sfx.flagCue(kind, team === w.playerTeam);
        // 'at' is the stand on a return — same converge ceremony as the
        // online path; no streak, the offline room doesn't keep a
        // dropped-pos marker to fly it from.
        if (kind === 'returned') flagReturnFx(at, team, null);
        deps.world.explosions.push(new Explosion(
          deps.lazyScene(), _flagBurst.copy(at).setY(at.y + 1.2), false, 0,
          deps.lazyTerrain(), kind === 'captured' ? 2.4 : kind === 'dropped' ? 1.0 : 1.4,
          TEAM_COLORS[team]));
      },
    }, deps.lazyPlayer().pos, w.bases, w.structures);
  }

  /** Objective data the per-bot ctx asks for. */
  objectiveInfoFor(bot: GameBot) { return this.ctf.objectiveInfoFor(bot); }

  /** A team's flag spot for radio-call aims: carried=false → the stand
   *  (home anchor), carried=true → the live flag pos (the thief's
   *  broadcast location — public info). */
  flagPos(team: string, carried: boolean): { x: number; y: number; z: number } | undefined {
    const m = this.ctf.markers().find((m) => m.team === team);
    if (!m) return undefined;
    if (carried) return m.state === 'carried' ? { x: m.pos.x, y: m.pos.y, z: m.pos.z } : undefined;
    return { x: m.home.x, y: m.home.y, z: m.home.z };
  }

  /** Flag-zone test — botMatch's CTF_PTS.flagZoneKill bonus reads it. */
  nearStand(pos: { x: number; y: number; z: number }, r: number): boolean {
    return this.ctf.nearStand(pos, r);
  }

  update(dt: number): void {
    this.ctf.update(dt);
    // Flag markers ride the player-indicator overlay — a DOM element
    // projects through terrain, which is the entire point.
    const cam = this.deps.lazyCamera();
    const hud = this.deps.lazyHud();
    for (const m of this.ctf.markers()) {
      // +3.4 → the indicator's own +1.0 puts the diamond at the 4m
      // pole tip instead of at the base's feet; a home flag also sits
      // one dais-height up (the pole seats on the platform deck).
      const lift = m.state === 'home' ? FLAG_STAND_TOP : 0;
      m.pos.y += 3.4 + lift;
      hud.updateFlagIndicator(`flag:${m.team}`, m.pos, cam, m.team);
      // Home flag: the hollow socket nests inside the flag diamond — one
      // complete glyph, same as the wire path. Away: the bare socket
      // marks the empty stand at deck height.
      if (m.state === 'home') {
        hud.updateFlagIndicator(`stand:${m.team}`, m.pos, cam, m.team, 'stand');
      } else {
        m.home.y += FLAG_STAND_TOP + 0.07;
        hud.updateFlagIndicator(`stand:${m.team}`, m.home, cam, m.team, 'stand');
        m.home.y -= FLAG_STAND_TOP + 0.07;
      }
      m.pos.y -= 3.4 + lift;
    }
  }

  /** TeamBots retire — drop the meshes AND the HUD diamonds they drove. */
  dispose(): void {
    const hud = this.deps.lazyHud();
    for (const m of this.ctf.markers()) {
      hud.removePlayerIndicator?.(`flag:${m.team}`);
      hud.removePlayerIndicator?.(`stand:${m.team}`);
    }
    this.ctf.dispose();
  }

  reset(): void { this.ctf.reset(); }

  dropCarried(carrierId: string, at: THREE.Vector3): void {
    this.ctf.dropCarried(carrierId, at);
  }

  /** Offline G-press — the bridge feeds the local player's aim since
   *  CtfFlags only knows positions, not look direction. */
  throwLocal(): void {
    const p = this.deps.lazyPlayer();
    if (p.isDead) return;
    this.ctf.throwLocal('local', p.pos, p.vel ?? _flagBurst.set(0, 0, 0), p.yaw, p.pitch);
  }

  private carrierPos(id: string): THREE.Vector3 | null {
    if (id === 'local') { const p = this.deps.lazyPlayer(); return p.isDead ? null : p.pos; }
    const rp = this.deps.world.remotePlayers.get(id);
    return rp && !rp.isDead ? rp.pos : null;
  }

  // Frame-ago toucher positions — the sweep segment's tail. Entries are
  // reused vectors (the flags module reads them synchronously each tick).
  private lastTouchPos = new Map<string, THREE.Vector3>();

  /** Jersey swap — touch tracker + role table follow the body. */
  rekey(oldId: string, newId: string): void {
    const v = this.lastTouchPos.get(oldId);
    this.lastTouchPos.delete(oldId);
    if (v !== undefined) this.lastTouchPos.set(newId, v);
    this.ctf.rekey(oldId, newId);
  }

  private touchers(bots: GameBot[]): [string, THREE.Vector3, THREE.Vector3][] {
    const player = this.deps.lazyPlayer();
    // Tail semantics: read prev BEFORE overwriting it with the new pos.
    _touchers.length = 0;
    if (!player.isDead) {
      const prev = this.lastTouchPos.get('local') ?? player.pos;
      this.lastTouchPos.set('local', (this.lastTouchPos.get('local') ?? new THREE.Vector3()).copy(player.pos));
      _touchers.push(['local', player.pos, prev]);
    }
    for (const b of bots) {
      if (b.isDead) continue;
      let prev = this.lastTouchPos.get(b.playerId);
      if (!prev) this.lastTouchPos.set(b.playerId, (prev = b.position.clone()));
      _touchers.push([b.playerId, b.position, prev]);
      prev.copy(b.position);
    }
    return _touchers;
  }
}
