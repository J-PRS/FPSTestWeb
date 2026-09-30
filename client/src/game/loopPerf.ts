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
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
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
// Explicit choices still win: ?px= or a user-set pixel mode pins the pixel
// tier; fps-shadows=false pins shadows.
function autoScale(deps: GameLoopDeps, st: LoopState, dir: number): void {
  if (st.cpuBound) return autoScaleCpu(deps, st, dir);
  const { rendererSetup } = deps;
  const pixelPinned = urlParams.get('px') !== null || (settings.get('fps-pixelated') !== 0 && !st.autoPixel);
  const cap = pixelPinned ? 1 : 5;
  const floor = (!settings.get('fps-shadows') && dir > 0) ? 1 : 0;
  const next = Math.min(cap, Math.max(floor, st.gpuLevel - dir));
  if (next === st.gpuLevel) return;
  const wantShadows = next === 0;
  if (rendererSetup.renderer.shadowMap.enabled !== wantShadows) setShadows(deps, wantShadows);
  const pixel = next <= 1 ? 0 : [0, 0, 2, 1, 3, 4][next]!;
  if (next >= 2 || st.autoPixel) { rendererSetup.setPixelated(pixel); st.autoPixel = true; }
  st.gpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: gpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
}

// CPU-bound ladder — JS phases dominate the frame, so a smaller buffer
// buys nothing; shed ambient JS work first, then drop res as a last resort.
function autoScaleCpu(deps: GameLoopDeps, st: LoopState, dir: number): void {
  const { rendererSetup } = deps;
  const pixelPinned = urlParams.get('px') !== null || (settings.get('fps-pixelated') !== 0 && !st.autoPixel);
  const cap = pixelPinned ? 1 : 2;
  const next = Math.min(cap, Math.max(0, st.cpuLevel - dir));
  if (next === st.cpuLevel) return;
  const ambientOn = next === 0;
  for (const layer of deps.ambientLayers) layer.setActive(ambientOn);
  deps.groundMist().setActive(ambientOn);
  deps.ambientBirds.setActive(ambientOn);
  if (next === 2 || (next === 1 && st.autoPixel)) { rendererSetup.setPixelated(next === 2 ? 1 : 0); st.autoPixel = true; }
  st.cpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: cpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
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
