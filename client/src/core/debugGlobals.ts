/** Debug/probe globals — one typed home for every `window.__x` handle the
 *  headless probes and console debugging reach for. Declaring them here
 *  keeps the cast sites honest: a renamed field type-errors instead of
 *  silently writing a key no probe reads. All optional — prod builds only
 *  get them under DEV or ?debug. */
import type * as THREE from 'three';
import type { Player } from '../entities/Player.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { DemoManager } from '../demo/index.js';
import type { Terrain } from '../world/terrain.js';
import type { createEntities } from '../game/entities.js';
import type { createRenderer } from '../core/renderer.js';
import type { WorldState } from '../game/worldState.js';
import type { chatSink } from '../game/chat.js';

export interface TestHandle {
  player: Player;
  scene: THREE.Scene;
  entities: ReturnType<typeof createEntities>;
  world: WorldState;
  terrain: Terrain;
  networkManager: NetworkManager;
  demoManager: DemoManager | null;
  rendererSetup: ReturnType<typeof createRenderer>;
  chatSink: typeof chatSink;
}

declare global {
  interface Window {
    __test?: TestHandle;
    /** phase-ms snapshot for the perf HUD (gameLoop debug wiring). */
    __perf?: () => Record<string, number>;
    /** renderScan draw-census helper (gameLoop debug wiring). */
    __renderScan?: unknown;
    __scene?: THREE.Scene;
    __renderer?: THREE.WebGLRenderer;
    __demoManager?: DemoManager;
    /** vfx pool hit/miss counters — perfprobe asserts pooling works. */
    __vfxStats?: { hits: number; misses: number };
    /** Standalone dump bundles (posedump/vmdump/sfxdump) — screenshot
     *  harnesses read these once ready. */
    __pm?: unknown;
    __clips?: string[];
    __ready?: boolean;
    __glb?: unknown;
    dump?: Promise<Record<string, string>>;
  }
}
