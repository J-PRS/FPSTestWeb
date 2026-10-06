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
import { vfxStats, setVfxQualityScale } from '../effects/vfx.js';
import type { createFrameBudget } from '../core/frameBudget.js';
import type { createPerfHud } from '../core/perfHud.js';
import type { GameLoopDeps, LoopState } from './gameLoop.js';

// Per-fxJob EMA ms — 'fx' was one opaque phase over nine rotated jobs;
// the dump couldn't tell the quarks batch from a legacy list pileup.
// EMA hides the burst spikes (a 2.5ms single-frame job averages away),
// so a decaying max rides beside it and resets with each dump.
// Owned here (not gameLoop) so loopPerf doesn't value-import the loop —
// one-directional dep.
const fxJobMs = new Map<string, number>();
const fxJobMax = new Map<string, number>();
export function fxJobSample(name: string, ms: number): void {
  fxJobMs.set(name, (fxJobMs.get(name) ?? 0) * 0.9 + ms * 0.1);
  if (ms > (fxJobMax.get(name) ?? 0)) fxJobMax.set(name, ms);
}
export function fxJobStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of fxJobMs) out[k] = +v.toFixed(2);
  for (const [k, v] of fxJobMax) out[`max:${k}`] = +v.toFixed(2);
  return out;
}
/** Clear the per-job maxes — called per dump so a spike doesn't fossilize. */
export function fxJobResetMax(): void { fxJobMax.clear(); }

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
  fxJobResetMax();
}

// Dynamic quality scaling — the render cost follows the machine instead of
// a manual ?shadows=off param. dir -1 steps down per sustained low-fps dump
// (10s throttle), +1 steps up per ~20s of >55fps headroom.
//
// GPU ladder (frame is mostly raster): 0 full → 1 shadows off → 2 (2×)
// → 3 (3×) → 4 (4×) → 5 (4× + dithered). Retro baselines enter at their
// own tier; non-retro baselines take the fractional RES_LADDER instead.
// CPU ladder (JS phases dominate): 0 all work → 1 ambient systems off
// (particles/mist/birds + slower HUD sweeps) → 2 + pixel mode regardless.
//
// fps-pscale/fps-pmode are the USER'S baseline, not the live pick: auto
// steps apply with persist=false, floor at the baseline's own ladder
// level (it may degrade further, never above it), and ?px=/atkinson
// stay fully pinned. fps-shadows=false pins shadows.
const LEGACY_PM = [[1,0],[4,0],[2,0],[4,1],[4,2],[4,3]] as const;
function baselinePixel(): { p: number; m: number } {
  if (localStorage.getItem('fps-pscale') !== null) {
    return { p: settings.get('fps-pscale'), m: settings.get('fps-pmode') };
  }
  const [p, m] = LEGACY_PM[settings.get('fps-pixelated')] ?? [1, 0];
  return { p, m };
}
// GPU level ↔ (pscale, pmode): 2→2x, 3→3x, 4→4x, 5→4x + dithered.
function tierOf(p: number, m: number): number {
  return p <= 1 ? 0 : p === 2 ? 2 : p === 3 ? 3 : m >= 2 ? 5 : 4;
}
function tierToPM(next: number, baseP: number, baseM: number): { p: number; m: number } {
  if (next <= 1) return { p: baseP, m: baseM };
  return { p: Math.min(4, next), m: next >= 5 ? 2 : baseM };
}
// Non-retro baselines get a gradual degrade: fractional render scale
// softens evenly, while hard-pixel modes would shimmer on non-integer
// factors — they keep the integer tiers above instead.
const RES_LADDER = [1, 1, 0.85, 0.7, 0.55, 0.4]; // gpu level → resScale

/** Where the GPU ladder wants to land: the user-pinned pixel baseline is
 *  the floor (degrade past it, never above), ?px=/atkinson pin the tier. */
function gpuLevelTarget(st: LoopState, dir: number, base: { p: number; m: number }): { next: number; baselineLevel: number } | null {
  const pixelPinned = urlParams.get('px') !== null || urlParams.get('pscale') !== null ||
    (base.p > 1 && base.m === 3);
  const baselineLevel = pixelPinned ? 0 : tierOf(base.p, base.m);
  const cap = pixelPinned ? 1 : 5;
  const floor = baselineLevel;
  const next = Math.min(cap, Math.max(floor, st.gpuLevel - dir));
  return next === st.gpuLevel ? null : { next, baselineLevel };
}

function autoScale(deps: GameLoopDeps, st: LoopState, dir: number): void {
  // The SETTINGS toggle is the master switch — an opted-out user keeps
  // their manual pixel/shadow picks no matter how low the fps sits.
  if (!settings.get('fps-autoq')) return;
  if (st.cpuBound) return autoScaleCpu(deps, st, dir);
  const { rendererSetup } = deps;
  const base = baselinePixel();
  const target = gpuLevelTarget(st, dir, base);
  if (!target) return;
  const { next, baselineLevel } = target;
  // Shadows shed with the pixel tier under pressure and restore on
  // recovery, but only while the USER's fps-shadows pick stays on —
  // setShadows must not overwrite it or a degrade would persist
  // shadow-off forever (and the old floor clause then trapped the
  // ladder at level 1, so it never came back).
  const wantShadows = settings.get('fps-shadows') &&
    (next === 0 || (baselineLevel > 0 && next === baselineLevel));
  if (rendererSetup.renderer.shadowMap.enabled !== wantShadows) setShadows(deps, wantShadows);
  applyResTier(deps, st, next, base, baselineLevel);
  // Full-sky raster FX shed before the deepest pixel drop: the cloud dome
  // shades every skyward fragment on a GPU that already can't keep up.
  deps.sceneSetup.volumetricClouds?.setEnabled(next < 3);
  shedPostPasses(rendererSetup, next >= 4);
  // Quarks sim is pure CPU — on weak GPUs (usually weak CPUs too, e.g.
  // chromebooks) thin burst density before the pressure curve engages.
  setVfxQualityScale(next >= 4 ? 0.45 : next >= 2 ? 0.7 : 1);
  st.gpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: gpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
}

function applyResTier(deps: GameLoopDeps, st: LoopState, next: number, base: { p: number; m: number }, baselineLevel: number): void {
  const { rendererSetup } = deps;
  if (next < 2 && !st.autoPixel) return;
  // Gradual path: resScale rungs replace the px jumps entirely; retro
  // baselines keep the integer tiers (non-integer factors shimmer).
  if (base.p <= 1) rendererSetup.setResScale(RES_LADDER[next]!);
  else {
    const t = tierToPM(next, base.p, base.m);
    rendererSetup.setPixel(t.p, t.m, false);
  }
  st.autoPixel = next > baselineLevel;
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
  const base = baselinePixel();
  const pixelPinned = urlParams.get('px') !== null || (base.p > 1 && base.m === 3);
  const cap = pixelPinned ? 1 : 2;
  const next = Math.min(cap, Math.max(0, st.cpuLevel - dir));
  if (next === st.cpuLevel) return;
  const ambientOn = next === 0;
  setVfxQualityScale(next === 0 ? 1 : next === 1 ? 0.6 : 0.4);
  for (const layer of deps.ambientLayers) layer.setActive(ambientOn);
  deps.groundMist().setActive(ambientOn);
  deps.ambientBirds.setActive(ambientOn);
  // Stepping back up restores the baseline pick, not necessarily OFF.
  if (next === 2 || (st.autoPixel && next < 2)) {
    // CPU-bound: drop to a 2x raw buffer (or the baseline's scale, mode
    // demoted to raw — CPU dither/xBR passes cost JS/GPU either way).
    if (next === 2) rendererSetup.setPixel(base.p > 1 ? base.p : 2, 0, false);
    else rendererSetup.setPixel(base.p, base.m, false);
    st.autoPixel = next === 2;
  }
  st.cpuLevel = next;
  Logger[dir < 0 ? 'warn' : 'info'](`auto-quality: cpu level ${next} (${dir < 0 ? 'sustained low fps' : 'headroom'})`);
}

/** Undo every ladder step — called when AUTO QUALITY flips off so the
 *  player isn't stranded on a degraded preset it chose for them. */
export function resetAutoQuality(deps: GameLoopDeps, st: LoopState): void {
  // Restore the stored baseline — the user's own pixel pick, not forced 0.
  if (st.autoPixel) {
    const base = baselinePixel();
    if (base.p <= 1) deps.rendererSetup.setResScale(1);
    else deps.rendererSetup.setPixel(base.p, base.m, false);
    st.autoPixel = false;
  }
  if (deps.rendererSetup.renderer.shadowMap.enabled !== settings.get('fps-shadows')) {
    setShadows(deps, settings.get('fps-shadows'));
  }
  for (const layer of deps.ambientLayers) layer.setActive(true);
  deps.groundMist().setActive(true);
  deps.ambientBirds.setActive(true);
  deps.sceneSetup.volumetricClouds?.setEnabled(true);
  shedPostPasses(deps.rendererSetup, false);
  setVfxQualityScale(1);
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
  // Deliberately NOT settings.set: fps-shadows is the user's stored pick,
  // the ladder only owns the runtime flag (see wantShadows above).
}
