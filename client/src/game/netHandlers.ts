// Server message wiring — assembles the shared NetCtx and hands it to the
// per-domain modules under ./net/. Each wire event lives in its domain file;
// this orchestrator only owns the cross-domain pieces (chat, lobby, pickup
// mesh factory feeding both pickups.ts and the join path in world.ts).

import type * as THREE from 'three';
import type { ChildLogger } from '../core/Logger.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import { Lobby , type RoomRow, type MapRow } from './lobby.js';
import { resolveServerEndpoints } from '../networking/endpoints.js';
import { settings } from '../core/settings.js';
import type { WorldState } from './worldState.js';
import type { createEntities } from './entities.js';
import type { FragMessages } from '../ui/FragMessages.js';
import { Chat } from './chat.js';
import { speakVgs } from '../core/tts.js';
import { Vgs } from './vgs.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { Terrain } from '../world/terrain.js';
import type { AmbientWeather } from '../effects/ambientWeather.js';

import type { NetCtx } from './net/ctx.js';
import { wireMatchEvents } from './net/match.js';
import { wireFlags } from './net/flags.js';
import { wireNodes } from './net/nodes.js';
import { wirePickups } from './net/pickups.js';
import { wirePlayers } from './net/players.js';
import { wireProjectiles } from './net/projectiles.js';
import { wireDeployables } from './net/deployables.js';
import { wireWorld } from './net/world.js';
import { wireResync } from './net/resync.js';
import { displayName } from './nameOf.js';
import type { DemoManager } from '../demo/DemoManager.js';

export interface NetDeps {
  lazyNetworkManager(): NetworkManager;
  lazyScene(): THREE.Scene;
  lazyTerrain(): Terrain;
  lazyWeather(): AmbientWeather;
  lazyPlayer(): Player;
  lazyEffects(): EffectsManager;
  lazyHud(): HUD;
  lazyHealthBarSystem(): HealthBarSystem;
  lazyDamageNumbers(): DamageNumberManager;
  lazyCamera(): THREE.Camera;
  /** Optional until initDemo runs — net handlers record through it when
   *  present so remote shots/creatures land in the rolling buffer. */
  lazyDemoManager?(): DemoManager | null;
  fragMessages: FragMessages;
  explosionTracker: ExplosionTracker;
  logger: ChildLogger;
  world: WorldState;
  setLastSentPos(pos: { x: number; y: number; z: number }): void;
  entities: () => ReturnType<typeof createEntities>;
  /** Offline-vs-bots roster lives client-side; a real room claiming the
   *  match (gameState with a room name) retires it — otherwise ghosts the
   *  server never heard of stand next to wire bots as unkillable decoys. */
  retireOfflineBots?(): void;
  /** The local player's chat/VGS — offline rooms never see the wire, so
   *  the bots need this to hear "gg" or a team command at all. */
  hearLocalChat?(text: string, team: boolean, vgs?: string): void;
}

export function wireNetworkHandlers(deps: NetDeps): NetCtx {
  const { logger } = deps;
  const nm = (): NetworkManager => deps.lazyNetworkManager();
  const networkManager = deps.lazyNetworkManager();

  // Chat is self-contained (own DOM + key routing) — net wiring is just
  // where network↔game glue already lives.
  const chat = new Chat({
    send: (text, team): void => { networkManager.sendChat(text, team); deps.hearLocalChat?.(text, team); },
    isConnected: (): boolean => networkManager.isConnected(),
    localName: (): string => networkManager.getLocalPlayerId(),
    // The roster is remote-only — the local id resolves through the
    // chosen nick from settings instead (same name we sent on join).
    nameFor: (id): string => id === networkManager.getLocalPlayerId()
      ? (settings.get('fps-name').trim() || id)
      : displayName(id, networkManager.getPlayers()),
    // /mute typed a display name — find the id it belongs to. Names are
    // non-unique, so an ambiguous hit just mutes the first match (the
    // id itself always works).
    idFor: (name): string | undefined => {
      if (networkManager.getPlayers().has(name)) {return name;}
      for (const [id, p] of networkManager.getPlayers()) {
        if (p.name === name) {return id;}
      }
      return undefined;
    },
  });
  // VGS lines arrive flagged with their chord — the feed prints
  // "[VGS] SHAZBOT!" (keypaths learnable from chat) and speaks through
  // the robot. Speech/formatting live inside chat.add so wire, host
  // relay, and offline echo paths all behave identically.
  networkManager.onChat = (playerId, text, team, vgsChord, muted): void => {
    chat.add(playerId, text, team, vgsChord, muted);
  };
  // V rides the same chat wire — tactical lines team-scoped, emotes global.
  // Self-contained like Chat — its key routing lives on window.
  const _vgs = new Vgs({
    send: (text, team, chord): void => { networkManager.sendChat(text, team, chord); deps.hearLocalChat?.(text, team, chord); },
    echo: (text, team, chord): void => chat.echoSelf(text, team, chord),
    speak: (text): void => speakVgs(text, networkManager.getLocalPlayerId()),
  });

  // Both first-seen-update and respawn-into-missing end up here.
  const ensureRemotePlayer = (playerId: string, position: { x: number; y: number; z: number }, via: string): RemotePlayer => {
    const rp = new RemotePlayer(deps.lazyScene(), playerId, position, deps.lazyTerrain());
    deps.world.remotePlayers.adopt(playerId, rp);
    logger.debug(`CREATED remote player (${via})`, { instanceId: rp.instanceId, playerId, total: deps.world.remotePlayers.size });
    return rp;
  };

  const ctx: NetCtx = {
    deps, nm, networkManager, chat, ensureRemotePlayer,
    addPickup: (): never => { throw new Error('addPickup assigned by wirePickups'); },
    reconcilePickups: (): never => { throw new Error('reconcilePickups assigned by wirePickups'); },
  };

  // Order matters: pickups defines ctx.addPickup which world.ts's gameState
  // handler consumes at runtime (not at wire time — safe either way).
  wireMatchEvents(ctx);
  wireFlags(ctx);
  wireNodes(ctx);
  wirePickups(ctx);
  wirePlayers(ctx);
  wireProjectiles(ctx);
  wireDeployables(ctx);
  wireWorld(ctx);
  wireResync(ctx);

  // Lobby browser — corner button lists the server's live rooms; joining
  // reloads onto /s/NAME (membership is fixed at connect time).
  resolveServerEndpoints().then(({ httpUrl, lobbyUrl, fleet }): Lobby => new Lobby({
    listRooms: async (): Promise<RoomRow[]> => {
      // Fleet: the matchmaker aggregates every worker's /rooms — a
      // worker-local fetch would hide the rest of the fleet.
      const res = await fetch(`${lobbyUrl ?? httpUrl}/rooms`);
      if (!res.ok) {throw new Error(`rooms ${res.status}`);}
      return res.json() as Promise<RoomRow[]>;
    },
    listMaps: async (): Promise<MapRow[]> => {
      const res = await fetch(`${httpUrl}/maps`);
      if (!res.ok) {throw new Error(`maps ${res.status}`);}
      return res.json() as Promise<MapRow[]>;
    },
    quickJoin: async (mode, map, bots, noCreatures, noBalls, instagib, gungame, igun): Promise<{ room: string; }> => {
      const q = new URLSearchParams({ mode });
      if (map) {q.set('map', map);}
      if (bots !== undefined) {q.set('bots', String(bots));}
      // The join mints the room — gates must ride HERE or the room
      // exists before the flag can ever reach it.
      if (noCreatures) {q.set('nocreatures', '1');}
      if (noBalls) {q.set('noballs', '1');}
      if (instagib) {q.set('instagib', '1');}
      if (gungame) {q.set('gungame', '1');}
      if (igun) {q.set('igun', '1');}
      // Fleet: the matchmaker's /join picks the emptiest room FLEET-wide
      // and pins its placement — a worker-local quickJoin would only see
      // that worker's rooms.
      const res = await fetch(`${lobbyUrl ?? httpUrl}/join?${q}`);
      if (!res.ok) {throw new Error(`join ${res.status}`);}
      return res.json() as Promise<{ room: string }>;
    },
    // Fleet: an in-place switchRoom hops within THIS worker only — a room
    // living on another process would silently mint a duplicate here.
    // Returning undefined takes the ?room= reload path, which re-resolves
    // through the matchmaker and lands on the owning worker.
    switchRoom: fleet ? undefined
      : (name, map, bots, mode, unlisted, noCreatures, noBalls, instagib, gungame, igun): boolean => networkManager.switchRoom(name, map, bots, mode, unlisted, noCreatures, noBalls, instagib, gungame, igun),
    mapThumbUrl: (name): string => `${httpUrl}/maps/thumbs/${name}.png`,
    isConnected: (): boolean => networkManager.isConnected(),
    listP2pLobbies: async (): Promise<{ room: string; since: number; }[]> => {
      const res = await fetch(`${httpUrl}/rtc/lobbies`);
      if (!res.ok) {throw new Error(`lobbies ${res.status}`);}
      return res.json() as Promise<{ room: string; since: number }[]>;
    },
  })).catch((error): void => {
    // Endpoint resolution failing leaves no lobby button — log it so a
    // dead /rooms host doesn't read as a missing feature.
    logger.warn('Lobby browser unavailable', error);
  });

  return ctx;
}
