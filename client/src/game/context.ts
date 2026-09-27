// Shared game context surface.
//
// Dep-bag convention: every field that must resolve lazily (constructed
// after the factory that receives it) is a `lazy*` getter — the naming is
// deliberate, it signals "call it when you need it, don't cache it at
// init". Plain fields (`world`, `logger`, `balls`, ...) are safe to read
// at construction time.
//
// CombatDeps and EntitiesDeps both extend this; new factories should take
// GameContext (plus their own extras) instead of growing another bespoke
// deps interface.

import type { Terrain } from '../world/terrain.js';
import type { Player } from '../entities/Player.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { EffectsManager } from '../effects/effects.js';
import type { HUD } from '../ui/hud.js';
import type { DemoManager } from '../demo/DemoManager.js';
import type { ChildLogger } from '../core/Logger.js';
import type { WorldState } from './worldState.js';

export interface GameContext {
  lazyPlayer: () => Player;
  lazyTerrain: () => Terrain;
  lazyEffects: () => EffectsManager;
  lazyHud: () => HUD;
  lazyNetworkManager: () => NetworkManager;
  lazyDemoManager: () => DemoManager | null;
  world: WorldState;
  logger: ChildLogger;
}
