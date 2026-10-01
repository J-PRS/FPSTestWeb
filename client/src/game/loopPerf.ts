/**
 * loopPerf — the adaptive-quality family for gameLoop: the low-FPS
 * watchdog (dump + degrade decision) and the GPU/CPU auto-scale ladders.
 * Kept apart so gameLoop owns orchestration while this owns "how the
 * frame budget responds when the machine can't keep up".
 */
import * as THREE from 'three';
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';
import Logger from '../core/Logger.js';
import { vfxStats } from '../effects/vfx.js';
import type { createFrameBudget } from '../core/frameBudget.js';
import type { createPerfHud } from '../core/perfHud.js';
import { fxJobStats } from './gameLoop.js';
import type { GameLoopDeps, LoopState } from './gameLoop.js';

// FPS watchdog — sustained <40fps for >10 consecutive frames fires a
// one-shot stats dump (ships to logs/client.log via the WARN+ pipeline),
// throttled to once per 10s. Uses rawElapsed, not clamped dt, and skips
// hidden tabs (rAF throttling ≠ real perf).
export function fpsWatchdog(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>, rawElapsed: number, now: number): void {
  if (document.hidden || rawElapsed <= 0) return;
  // A >0.5s frame isn't a slow frame — it's an rAF stall (occluded/
  // headless tab, OS jank). Counting them reported "avgFps 1" dumps on
  // machines rendering fine; stalls fall into the healthy branch and
  // reset the counter instead.
  if (1 / rawElapsed < 40 && rawElapsed < 0.5) { st.lowFpsFrames++; st.lowFpsAccum += rawElapsed; st.headroomAccum = 0; }
  else {
    st.lowFpsFrames = 0; st.lowFpsAccum = 0;
    // Comfortable headroom: >55fps accumulates toward a quality step-UP.
    // 20s of sustained headroom per step keeps the ladder from bouncing.
    if (1 / rawElapsed > 55) {
      st.headroomAccum += rawElapsed;
      if (st.headroomAccum > 20) { st.headroomAccum = 0; autoScale(deps, st, +1); }
    }
  }
  if (st.lowFpsFrames > 10 && now - st.lastFpsDump > 10_000) {
    st.lastFpsDump = now;
    // JS share of the slow frames decides which axis degrades: sim/HUD
    // phases over a third of frame time is a CPU-throttled box, and
    // dropping resolution would only shrink the raster it wasn't bound on.
    const phases = perf.snapshot();
    const jsMs = Object.values(phases).reduce((a, v) => a + v, 0);
    st.cpuBound = jsMs > (st.lowFpsAccum / st.lowFpsFrames) * 1000 * 0.35;
    dumpPerf(deps, st, budget, perf);
    st.lowFpsFrames = 0; st.lowFpsAccum = 0;
    autoScale(deps, st, -1);
  }
}

function dumpPerf(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>): void {
  const player = deps.lazyPlayer();
  const nm = deps.lazyNetworkManager();
  const info = deps.rendererSetup.renderer.info;
  const entities = deps.entities;
  Logger.warn('LOW FPS sustained — perf dump', {
    avgFps: Math.round(st.lowFpsFrames / st.lowFpsAccum),
    frames: st.lowFpsFrames,
    pos: { x: +player.pos.x.toFixed(1), y: +player.pos.y.toFixed(1), z: +player.pos.z.toFixed(1) },
    speed: +player.vel.length().toFixed(1),
    dead: player.isDead,
    demo: deps.lazyDemoManager()?.isPlaying ?? false,
    targets: entities.targets.length,
    balls: entities.balls.filter(b => !b.dead && !b.disposed).length,
    nuggets: entities.nuggets.length,
    remotes: deps.world.remotePlayers.size,
    projectiles: deps.world.projectiles.length,
    explosions: deps.world.explosions.length,
    debris: deps.world.debrisList.length + deps.world.playerDebrisList.length,
    scorches: deps.world.scorches.length,
    vfx: vfxStats(),
    fxJobs: fxJobStats(),
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    // "SwiftShader"/"ANGLE (Google, Vulkan)" — the whole frame-vs-fps gap
    // question answered inside the dump instead of a chrome://gpu detour.
    gl: gpuId(deps.rendererSetup.renderer),
    dpr: Math.round(window.devicePixelRatio * 100) / 100,
    res: `${deps.rendererSetup.renderer.domElement.width}x${deps.rendererSetup.renderer.domElement.height}`,
    phases: perf.snapshot(),
    budget: budget.stats(),
    ping: nm?.getPing?.(),
    packetLoss: nm?.getPacketLoss?.(),
    heapMB: (performance as { memory?: { usedJSHeapSize: number } }).memory
      ? Math.round((performance as { memory?: { usedJSHeapSize: number } }).memory!.usedJSHeapSize / 1048576)
      : undefined,
  });
  // worstItemMs is an all-time max — reset per dump so it reflects the
  // current window, not a fossil from the worst frame ever recorded.
  budget.reset('fxdecay');
}

// Dynamic quality scaling — the render cost follows the machine instead of
// a manual ?shadows=off param. dir -1 steps down per sustained low-fps dump
// (10s throttle), +1 steps up per ~20s of >55fps headroom.
//
// GPU ladder (frame is mostly raster): 0 full → 1 shadows off → 2 px-mode 2
// (2×) → 3 px-mode 1 (4×) → 4 px-mode 3 → 5 px-mode 4 (low-res composer).
// CPU ladder (JS phases dominate): 0 all work → 1 ambient systems off
// (particles/mist/birds + slower HUD sweeps) → 2 + pixel mode regardless.
//
// fps-pixelated is the USER'S baseline, not the live mode: auto steps
// apply with persist=false, floor at the baseline's own ladder level
// (it may degrade further, never above it), and ?px=/floyd stay fully
// pinned. fps-shadows=false pins shadows.
const PX2LEVEL = [0, 3, 2, 4, 5]; // pixelMode → gpu level where it sits
const PX_LADDER = [0, 0, 2, 1, 3, 4]; // gpu level → pixel mode

/** Where the GPU ladder wants to land: the user-pinned pixel baseline is
 *  the floor (degrade past it, never above), ?px=/floyd pin the tier. */
function gpuLevelTarget(st: LoopState, dir: number, baselinePx: number): { next: number; baselineLevel: number } | null {
  const pixelPinned = urlParams.get('px') !== null || baselinePx === 5;
  const baselineLevel = pixelPinned ? 0 : PX2LEVEL[baselinePx]!;
  const cap = pixelPinned ? 1 : 5;
  const floor = Math.max(baselineLevel, (!settings.get('fps-shadows') && dir > 0) ? 1 : 0);
  const next = Math.min(cap, Math.max(floor, st.gpuLevel - dir));
  return next === st.gpuLevel ? null : { next, baselineLevel };
}

function autoScale(deps: GameLoopDeps, st: LoopState, dir: number): void {
  // The SETTINGS toggle is the master switch — an opted-out user keeps
  // their manual pixel/shadow picks no matter how low the fps sits.
  if (!settings.get('fps-autoq')) return;
  if (st.cpuBound) return autoScaleCpu(deps, st, dir);
  const { rendererSetup } = deps;
  const baselinePx = settings.get('fps-pixelated');
  const target = gpuLevelTarget(st, dir, baselinePx);
  if (!target) return;
  const { next, baselineLevel } = target;
  // A pixelated baseline shouldn't imply shadows off: at the resting
  // level, shadows follow the user's own fps-shadows pick.
  const wantShadows = next === 0 ||
    (baselineLevel > 0 && next === baselineLevel && settings.get('fps-shadows'));
  if (rendererSetup.renderer.shadowMap.enabled !== wantShadows) setShadows(deps, wantShadows);
  const pixel = next <= 1 ? baselinePx : PX_LADDER[next]!;
  if (next >= 2 || st.autoPixel) {
    rendererSetup.setPixelated(pixel, false);
    st.autoPixel = next > baselineLevel;
  }
  // Full-sky raster FX shed before the deepest pixel drop: the cloud dome
  // shades every skyward fragment on a GPU that already can't keep up.
  deps.sceneSetup.volumetricClouds?.setEnabled(next < 3);
  shedPostPasses(rendererSetup, next >= 4);
  st.gpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: gpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
}

let _gpuId: string | null = null;
function gpuId(renderer: THREE.WebGLRenderer): string {
  if (_gpuId) return _gpuId;
  const gl = renderer.getContext() as WebGLRenderingContext;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  _gpuId = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : 'unknown';
  return _gpuId;
}

// Post passes are pure fill cost — bloom's mip-blur chain is the last
// thing a starving GPU needs. Shed at the deepest tier and restore by
// the user's own toggles on recovery (pass flags only, settings kept).
function shedPostPasses(rendererSetup: GameLoopDeps['rendererSetup'], shed: boolean): void {
  if (rendererSetup.bloomPass) rendererSetup.bloomPass.enabled = !shed && rendererSetup.isBloomEnabled();
  if (rendererSetup.contrastPass) rendererSetup.contrastPass.enabled = !shed && rendererSetup.isPostProcessingEnabled();
}

// CPU-bound ladder — JS phases dominate the frame, so a smaller buffer
// buys nothing; shed ambient JS work first, then drop res as a last resort.
function autoScaleCpu(deps: GameLoopDeps, st: LoopState, dir: number): void {
  const { rendererSetup } = deps;
  const baselinePx = settings.get('fps-pixelated');
  const pixelPinned = urlParams.get('px') !== null || baselinePx === 5;
  const cap = pixelPinned ? 1 : 2;
  const next = Math.min(cap, Math.max(0, st.cpuLevel - dir));
  if (next === st.cpuLevel) return;
  const ambientOn = next === 0;
  for (const layer of deps.ambientLayers) layer.setActive(ambientOn);
  deps.groundMist().setActive(ambientOn);
  deps.ambientBirds.setActive(ambientOn);
  // Stepping back up restores the baseline pick, not necessarily OFF.
  if (next === 2 || (st.autoPixel && next < 2)) {
    rendererSetup.setPixelated(next === 2 ? 1 : baselinePx, false);
    st.autoPixel = next === 2;
  }
  st.cpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: cpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
}

/** Undo every ladder step — called when AUTO QUALITY flips off so the
 *  player isn't stranded on a degraded preset it chose for them. */
export function resetAutoQuality(deps: GameLoopDeps, st: LoopState): void {
  // Restore the stored baseline — the user's own pixel pick, not forced 0.
  if (st.autoPixel) { deps.rendererSetup.setPixelated(settings.get('fps-pixelated'), false); st.autoPixel = false; }
  if (deps.rendererSetup.renderer.shadowMap.enabled !== settings.get('fps-shadows')) {
    setShadows(deps, settings.get('fps-shadows'));
  }
  for (const layer of deps.ambientLayers) layer.setActive(true);
  deps.groundMist().setActive(true);
  deps.ambientBirds.setActive(true);
  deps.sceneSetup.volumetricClouds?.setEnabled(true);
  shedPostPasses(deps.rendererSetup, false);
  st.gpuLevel = 0;
  st.cpuLevel = 0;
}

function setShadows(deps: GameLoopDeps, on: boolean): void {
  const { rendererSetup, sceneSetup } = deps;
  rendererSetup.renderer.shadowMap.enabled = on;
  sceneSetup.sun.castShadow = on;
  // Lit materials cache shadow uniforms — flag for recompile once.
  sceneSetup.scene.traverse(o => {
    const m = (o as THREE.Mesh).material;
    if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.needsUpdate = true; });
  });
  settings.set('fps-shadows', on);
}
