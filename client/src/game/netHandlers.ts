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
import { Lobby } from './lobby.js';
import { resolveServerEndpoints } from '../networking/endpoints.js';
import type { WorldState } from './worldState.js';
import type { createEntities } from './entities.js';
import type { FragMessages } from '../ui/FragMessages.js';
import { Chat } from './chat.js';
import { speakVgs } from '../core/tts.js';
import { Vgs } from './vgs.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { Terrain } from '../world/terrain.js';

import type { NetCtx } from './net/ctx.js';
import { wireMatchEvents } from './net/match.js';
import { wireFlags } from './net/flags.js';
import { wirePickups } from './net/pickups.js';
import { wirePlayers } from './net/players.js';
import { wireProjectiles } from './net/projectiles.js';
import { wireDeployables } from './net/deployables.js';
import { wireWorld } from './net/world.js';
import { wireResync } from './net/resync.js';
import { displayName } from './nameOf.js';

export interface NetDeps {
  lazyNetworkManager(): NetworkManager;
  lazyScene(): THREE.Scene;
  lazyTerrain(): Terrain;
  lazyPlayer(): Player;
  lazyEffects(): EffectsManager;
  lazyHud(): HUD;
  lazyHealthBarSystem(): HealthBarSystem;
  /** Optional until initDemo runs — net handlers record through it when
   *  present so remote shots/creatures land in the rolling buffer. */
  lazyDemoManager?(): import('../demo/DemoManager.js').DemoManager | null;
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
}

export function wireNetworkHandlers(deps: NetDeps): NetCtx {
  const { logger } = deps;
  const nm = () => deps.lazyNetworkManager();
  const networkManager = deps.lazyNetworkManager();

  // Chat is self-contained (own DOM + key routing) — net wiring is just
  // where network↔game glue already lives.
  const chat = new Chat({
    send: (text, team) => networkManager.sendChat(text, team),
    isConnected: () => networkManager.isConnected(),
    localName: () => networkManager.getLocalPlayerId(),
    nameFor: (id) => displayName(id, networkManager.getPlayers()),
    // /mute typed a display name — find the id it belongs to. Names are
    // non-unique, so an ambiguous hit just mutes the first match (the
    // id itself always works).
    idFor: (name) => {
      if (networkManager.getPlayers().has(name)) return name;
      for (const [id, p] of networkManager.getPlayers()) {
        if (p.name === name) return id;
      }
      return undefined;
    },
  });
  // VGS lines arrive flagged with their chord — the feed prints
  // "[VGS] SHAZBOT!" (keypaths learnable from chat) and speaks through
  // the robot. Speech/formatting live inside chat.add so wire, host
  // relay, and offline echo paths all behave identically.
  networkManager.onChat = (playerId, text, team, vgsChord, muted) => {
    chat.add(playerId, text, team, vgsChord, muted);
  };
  // V rides the same chat wire — tactical lines team-scoped, emotes global.
  const vgs = new Vgs({
    send: (text, team, chord) => networkManager.sendChat(text, team, chord),
    echo: (text, team, chord) => chat.echoSelf(text, team, chord),
    speak: (text) => speakVgs(text, networkManager.getLocalPlayerId()),
  });
  vgs; // self-contained like Chat — its key routing lives on window

  // Both first-seen-update and respawn-into-missing end up here.
  const ensureRemotePlayer = (playerId: string, position: { x: number; y: number; z: number }, via: string): RemotePlayer => {
    const rp = new RemotePlayer(deps.lazyScene(), playerId, position, deps.lazyTerrain());
    deps.world.remotePlayers.adopt(playerId, rp);
    logger.debug(`CREATED remote player (${via})`, { instanceId: rp.instanceId, playerId, total: deps.world.remotePlayers.size });
    return rp;
  };

  const ctx: NetCtx = {
    deps, nm, networkManager, chat, ensureRemotePlayer,
    addPickup: () => { throw new Error('addPickup assigned by wirePickups'); },
    reconcilePickups: () => { throw new Error('reconcilePickups assigned by wirePickups'); },
  };

  // Order matters: pickups defines ctx.addPickup which world.ts's gameState
  // handler consumes at runtime (not at wire time — safe either way).
  wireMatchEvents(ctx);
  wireFlags(ctx);
  wirePickups(ctx);
  wirePlayers(ctx);
  wireProjectiles(ctx);
  wireDeployables(ctx);
  wireWorld(ctx);
  wireResync(ctx);

  // Lobby browser — corner button lists the server's live rooms; joining
  // reloads with ?room=NAME (membership is fixed at connect time).
  resolveServerEndpoints().then(({ httpUrl }) => new Lobby({
    listRooms: async () => {
      const res = await fetch(`${httpUrl}/rooms`);
      if (!res.ok) {throw new Error(`rooms ${res.status}`);}
      return res.json() as Promise<import('./lobby.js').RoomRow[]>;
    },
    listMaps: async () => {
      const res = await fetch(`${httpUrl}/maps`);
      if (!res.ok) {throw new Error(`maps ${res.status}`);}
      return res.json() as Promise<import('./lobby.js').MapRow[]>;
    },
    quickJoin: async (mode, map, bots) => {
      const q = new URLSearchParams({ mode });
      if (map) {q.set('map', map);}
      if (bots !== undefined) {q.set('bots', String(bots));}
      const res = await fetch(`${httpUrl}/join?${q}`);
      if (!res.ok) {throw new Error(`join ${res.status}`);}
      return res.json() as Promise<{ room: string }>;
    },
    switchRoom: (name, map, bots, mode, unlisted) => networkManager.switchRoom(name, map, bots, mode, unlisted),
    mapThumbUrl: (name) => `${httpUrl}/maps/thumbs/${name}.png`,
    isConnected: () => networkManager.isConnected(),
    listP2pLobbies: async () => {
      const res = await fetch(`${httpUrl}/rtc/lobbies`);
      if (!res.ok) {throw new Error(`lobbies ${res.status}`);}
      return res.json() as Promise<{ room: string; since: number }[]>;
    },
  })).catch((error) => {
    // Endpoint resolution failing leaves no lobby button — log it so a
    // dead /rooms host doesn't read as a missing feature.
    logger.warn('Lobby browser unavailable', error);
  });

  return ctx;
}
