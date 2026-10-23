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
import type { ViewModel } from '../entities/ViewModel.js';
import type { createDemoLifecycle } from '../game/demoLifecycle.js';
import type { HUD } from '../ui/hud.js';

export interface TestHandle {
  player: Player;
  scene: THREE.Scene;
  entities: ReturnType<typeof createEntities>;
  world: WorldState;
  terrain: Terrain;
  viewModel: ViewModel;
  networkManager: NetworkManager;
  demoManager: DemoManager | null;
  rendererSetup: ReturnType<typeof createRenderer>;
  /** Playback truth lives here during a replay (playbackRemotes/playbackBallById) —
   *  probes must read it, not world.remotePlayers, to compare replay vs live. */
  demoLifecycle: ReturnType<typeof createDemoLifecycle>;
  chatSink: typeof chatSink;
  hud: HUD;
  /** parity.ts counters — fates/echoes census for soak verdicts. */
  parity: { fatesSeen: number; echoesStamped: number; echoesConfirmed: number; destroysSeen: number; msgSeen: Record<string, number> };
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
    /** Merged FX census — sections self-register via registerDiag() in the
     *  owning modules (vfx pools, ribbons, inst pools, swarms…). Sections
     *  are optional: a section absent means its module never loaded. */
    __trailDump?: () => Record<string, unknown>;
    /** Render-pipeline census — registered by createRenderer; the Alt+Q
     *  dump reads it for the pixel-mode/AA/pass-state section. */
    __renderDump?: () => Record<string, unknown>;
    /** Standalone dump bundles (posedump/vmdump/sfxdump) — screenshot
     *  harnesses read these once ready. */
    __pm?: unknown;
    /** .rec wire-capture replay through the live pipeline (dev only). */
    __playRec?: (src: string | File, speed?: number) => Promise<() => void>;
    /** ?autopilot — shared BotBrain driving the local player's inputs. */
    __botpilot?: { stop: () => void };
    /** ?telemetry=deep — the flight recorder's journal dump. */
    __telemetry?: { enabled: boolean; dump: () => Record<string, unknown> };
    __clips?: string[];
    __ready?: boolean;
    __glb?: unknown;
    dump?: Promise<Record<string, string>>;
  }
}
