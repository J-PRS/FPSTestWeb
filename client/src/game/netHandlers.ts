// Server message wiring — assembles the shared NetCtx and hands it to the
// per-domain modules under ./net/. Each wire event lives in its domain file;
// this orchestrator only owns the cross-domain pieces (chat, lobby, pickup
// mesh factory feeding both pickups.ts and the join path in world.ts).

import * as THREE from 'three';
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

export interface NetDeps {
  lazyNetworkManager(): NetworkManager;
  lazyScene(): THREE.Scene;
  lazyTerrain(): Terrain;
  lazyPlayer(): Player;
  lazyEffects(): EffectsManager;
  lazyHud(): HUD;
  lazyHealthBarSystem(): HealthBarSystem;
  fragMessages: FragMessages;
  explosionTracker: ExplosionTracker;
  logger: ChildLogger;
  world: WorldState;
  setLastSentPos(pos: { x: number; y: number; z: number }): void;
  entities: () => ReturnType<typeof createEntities>;
}

export function wireNetworkHandlers(deps: NetDeps): void {
  const { logger } = deps;
  const nm = () => deps.lazyNetworkManager();
  const networkManager = deps.lazyNetworkManager();

  // Chat is self-contained (own DOM + key routing) — net wiring is just
  // where network↔game glue already lives.
  const chat = new Chat({
    send: (text) => networkManager.sendChat(text),
    isConnected: () => networkManager.isConnected(),
    localName: () => networkManager.getLocalPlayerId(),
  });
  networkManager.onChat = (playerId, text) => chat.add(playerId, text);

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

  // Lobby browser — corner button lists the server's live rooms; joining
  // reloads with ?room=NAME (membership is fixed at connect time).
  void resolveServerEndpoints().then(({ httpUrl }) => new Lobby({
    listRooms: async () => {
      const res = await fetch(`${httpUrl}/rooms`);
      if (!res.ok) throw new Error(`rooms ${res.status}`);
      return res.json() as Promise<import('./lobby.js').RoomRow[]>;
    },
    listMaps: async () => {
      const res = await fetch(`${httpUrl}/maps`);
      if (!res.ok) throw new Error(`maps ${res.status}`);
      return res.json() as Promise<import('./lobby.js').MapRow[]>;
    },
    quickJoin: async (mode, map, bots) => {
      const q = new URLSearchParams({ mode });
      if (map) q.set('map', map);
      if (bots !== undefined) q.set('bots', String(bots));
      const res = await fetch(`${httpUrl}/join?${q}`);
      if (!res.ok) throw new Error(`join ${res.status}`);
      return res.json() as Promise<{ room: string }>;
    },
  }));
}
