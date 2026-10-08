import * as THREE from 'three';
import { settings } from './settings.js';
import { urlParams } from './params.js';
import {
  Effect,
  EffectComposer,
  RenderPass,
  EffectPass,
  Pass,
  BloomEffect,
  BrightnessContrastEffect,
  BlendFunction,
  FXAAEffect,
  SMAAEffect,
} from 'postprocessing';
import {
  TONE_MAPPING_EXPOSURE,
} from './config.js';
import { UPSCALE_GLSL, XBR_GLSL, ACES_GLSL, LENS_DIRT_GLSL, SANITIZE_GLSL, BLOOM_MERGE_GLSL } from './rendererShaders.js';
import { setFxBufferHeight } from './fxViewport.js';

export interface RendererSetup {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: EffectPass;
  contrastPass: EffectPass;
  render: (dt?: number) => void;
  needsComposer: () => boolean;
  /** FLOYD mode: extra draw onto the GL canvas between scene render and the
   *  readPixels (the viewmodel pass — otherwise the gun vanishes in FS). */
  setOverlayPass: (fn: (() => void) | null) => void;
  isFloyd: () => boolean;
  isPostProcessingEnabled: () => boolean;
  isBloomEnabled: () => boolean;
  setBloomEnabled: (enabled: boolean) => void;
  updateRendererSize: () => void;
  /** Parallel-compile every scene material (KHR_parallel_shader_compile)
   *  so programs don't lazily stall their first draw. */
  warmup: () => void;
  /** Retro pixel pipeline as two axes: integer size divisor (1-4) and
   *  mode (0 raw / 1 smooth-xBR / 2 dithered / 3 atkinson). scale=1
   *  disables the pipeline entirely. */
  setPixel: (scale: number, mode: number, persist?: boolean) => void;
  /** Fractional resolution scale (auto-quality degrade) — softens the
   *  frame evenly via pixel-ratio scaling; only meaningful outside the
   *  hard-pixel modes, which need integer factors to keep the chunky
   *  grid regular. */
  setResScale: (scale: number) => void;
  setPostProcessingEnabled: (enabled: boolean) => void;
  resize: (width: number, height: number) => void;
}

interface RenderModes { pscale: number; pmode: number; postproEnabled: boolean; bloomEnabled: boolean; dirtOff: boolean }

// Legacy ?pixelated= / stored fps-pixelated values mapped onto the new
// (scale, mode) pair: off→1x, hard→4x raw, medium→2x raw, smooth→4x
// smooth, dithered→4x dithered, floyd→4x atkinson.
const LEGACY_PM: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [4, 0], [2, 0], [4, 1], [4, 2], [4, 3],
];
const PX_MODES: Record<string, number> = {
  off: 0, hard: 1, medium: 2, smooth: 3, on: 3, dither: 4, dithered: 4, fs: 5, floyd: 5,
};

// Potato first-run: no stored pixel/shadow picks + a weak GL renderer →
// start on the low tier instead of laddering down through 10s of 4fps.
// Explicit user picks (any stored key) always win.
const WEAK_GL = /swiftshader|llvmpipe|software|intel.*(hd|uhd)\s?graphics|mali|adreno\s?[0-5]|videocore/i;
function detectWeakGpu(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return true; // no GL at all — deepest tier either way
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return WEAK_GL.test(r);
  } catch { return false; }
}
function seedPotatoDefaults(): void {
  if (settings.has('fps-pixelated') || settings.has('fps-pscale') || settings.has('fps-shadows')) return;
  if (!detectWeakGpu()) return;
  settings.set('fps-pscale', 4);
  settings.set('fps-shadows', false);
}

// Pixel pipeline = two axes: fps-pscale (integer divisor 1-4) and
// fps-pmode (0 raw / 1 smooth-xBR / 2 dithered / 3 atkinson). Old
// single-dimension fps-pixelated values migrate through LEGACY_PM.
function resolveModes(): RenderModes {
  let pscale = settings.get('fps-pscale');
  let pmode = settings.get('fps-pmode');
  if (!settings.has('fps-pscale')) {
    [pscale, pmode] = LEGACY_PM[settings.get('fps-pixelated')] ?? [1, 0];
  }
  // All post-processing defaults OFF — the scene reads cleanest raw.
  // Opt in via localStorage or ?postpro=on / ?bloom=on.
  let postproEnabled = settings.get('fps-postpro');
  let bloomEnabled = settings.get('fps-bloom');
  // URL overrides for headless screenshots/testing
  const px = urlParams.get('pixelated');
  if (px !== null && px in PX_MODES) [pscale, pmode] = LEGACY_PM[PX_MODES[px]!] ?? [1, 0];
  const ps = urlParams.get('pscale');
  if (ps !== null) pscale = Math.min(4, Math.max(1, parseInt(ps, 10) || 1));
  const pm = urlParams.get('pmode');
  if (pm !== null) pmode = Math.min(3, Math.max(0, parseInt(pm, 10) || 0));
  const pp = urlParams.get('postpro');
  if (pp !== null) postproEnabled = pp === 'on';
  const bm = urlParams.get('bloom');
  if (bm !== null) bloomEnabled = bm === 'on';
  // Atkinson bypasses the composer entirely (GL render → CPU quantize),
  // so postpro/bloom can never engage under it — suppress dead toggles.
  if (pmode === 3) {
    postproEnabled = false;
    bloomEnabled = false;
  }
  // ?dirt=off — isolates the lens-dirt stage when bisecting the
  // black-frame NaN smear (bloom stays on, dirt never samples it).
  const dirtOff = urlParams.get('dirt') === 'off';
  return { pscale, pmode, postproEnabled, bloomEnabled, dirtOff };
}

const FS_LEVELS = 6; // per-channel quantization — 4 was chroma-noise soup

// ---- Floyd-Steinberg mode (5): real CPU error diffusion ----
// GL canvas renders at hard-mode scale but stays hidden; each frame we
// readPixels → F-S quantize in JS → putImageData to this 2D canvas which
// CSS upscales. Costs a few ms + one pipeline stall per frame — that's
// the experiment.
function makeFloydEngine(renderer: THREE.WebGLRenderer) {
  const canvasEl = document.createElement('canvas');
  const ctx2d = canvasEl.getContext('2d')!;
  let buf: Uint8ClampedArray | null = null;
  let img: ImageData | null = null;
  let errA = new Float32Array(0);
  let errB = new Float32Array(0);

  function alloc(w: number, h: number): void {
    buf = new Uint8ClampedArray(w * h * 4);
    img = ctx2d.createImageData(w, h);
    errA = new Float32Array((w + 2) * 3);
    errB = new Float32Array((w + 2) * 3);
  }

  function quantize(): void {
    const w = canvasEl.width, h = canvasEl.height;
    if (!w || !h || !buf || !img) return;
    const gl = renderer.getContext();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const src = buf, dst = img.data, step = 255 / (FS_LEVELS - 1);
    for (let y = 0; y < h; y++) {
      const cur = errA; errA = errB; errB = cur; errB.fill(0);
      ditherRow(y, src, dst, w, h, step);
    }
    ctx2d.putImageData(img, 0, 0);
  }

  /** One serpentine row of quantize + error push — extracted so
   *  quantize() isn't carrying the per-channel conditionals. errA/errB
   *  (and their swap) live on the engine closure. */
  function ditherRow(y: number, src: Uint8ClampedArray, dst: Uint8ClampedArray,
      w: number, h: number, step: number): void {
    const srcRow = (h - 1 - y) * w * 4; // GL rows are bottom-up — flip here
    const dstRow = y * w * 4;
    // Serpentine: alternate scan direction per row — pure raster order
    // smears error one way and leaves diagonal worm artifacts
    const fwd = (y & 1) === 0;
    const ahead = fwd ? 3 : -3, behind = -ahead;
    for (let xi = 0; xi < w; xi++) {
      const x = fwd ? xi : w - 1 - xi;
      const si = srcRow + x * 4, di = dstRow + x * 4, ei = x * 3;
      for (let c = 0; c < 3; c++) {
        const v = src[si + c] + errA[ei + c];
        const q = v < 0 ? 0 : v > 255 ? 255 : Math.round(v / step) * step;
        const e = v - q;
        errA[ei + ahead + c] += e * 0.4375;
        errB[ei + c]         += e * 0.3125;
        errB[ei + ahead + c] += e * 0.0625;
        errB[ei + behind + c] += e * 0.1875;
        dst[di + c] = q;
      }
      dst[di + 3] = 255;
    }
  }

  return { canvasEl, alloc, quantize };
}



// Low-res sizing for the CSS-upscaled paths: RAW (nearest upscale by
// definition — that's the retro look) and ATKINSON (hidden GL feed for
// the CPU dither canvas). Composer modes (smooth/dithered) keep a
// full-res canvas and shrink buffers instead. Returns true when the
// canvas was shrunk. GL canvas MUST stay visible — pointer lock targets
// it; fsCanvas is pointer-events:none.
// The world renders a canonical 16:9 frame at every window shape: the
// canvas is oversized to cover the window at that aspect and CSS
// center-crops it, so a non-16:9 window crops (never squashes) the same
// frame — every player sees identical vertical FOV, and video capture of
// the canvas is natively 16:9 with no staging pass. body{overflow:hidden}
// already crops the overscan; the canvas stays centered via transform.
export const GAME_ASPECT = 16 / 9;

export function overscanSize(): { w: number; h: number } {
  let w = window.innerWidth;
  let h = window.innerHeight;
  if (w / h < GAME_ASPECT) {w = Math.ceil(h * GAME_ASPECT);} else {h = Math.ceil(w / GAME_ASPECT);}
  return { w, h };
}

function applyPixelSize(renderer: THREE.WebGLRenderer,
    fsCanvas: HTMLCanvasElement, pscale: number, pmode: number): boolean {
  fsCanvas.style.display = pmode === 3 ? 'block' : 'none';
  if (pscale <= 1 || (pmode !== 0 && pmode !== 3)) return false;
  const { w, h } = overscanSize();
  renderer.setPixelRatio(1);
  renderer.setSize(Math.floor(w / pscale),
    Math.floor(h / pscale), false);
  renderer.domElement.style.imageRendering = 'pixelated';
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
  return true;
}


// Whole-scene bloom gated by a luminance threshold: emitters (trails,
// explosions, nuggets) push the brightest colors, the lit terrain and sky
// stay under it, so bloom never washes the frame. (A second composer and
// SelectiveBloomEffect both proved fragile here — keep the simple one.)
// SafeBloomEffect: same BloomEffect, but the merge shader zeroes
// non-finite bloom-texture samples instead of letting a NaN write black
// through the SCREEN blend — see BLOOM_MERGE_GLSL.
class SafeBloomEffect extends BloomEffect {
  constructor(opts: ConstructorParameters<typeof BloomEffect>[0]) {
    super(opts);
    this.setFragmentShader(BLOOM_MERGE_GLSL);
  }
}
// Viewmodel-aware scene pass — the gun scene draws into the same frame
// buffer right after the world (depth cleared, color kept), so the WHOLE
// chain downstream treats it as scene content: bloom, grade, and the
// smooth/dithered upscale. Without this the viewmodel was composited on
// canvas after the composer — full-res and unprocessed on a chunky frame.
class VmRenderPass extends RenderPass {
  /** Draw hook — the same overlay fn floyd injects pre-readback. */
  vmDraw: (() => void) | null = null;
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null,
      outputBuffer: THREE.WebGLRenderTarget | null, deltaTime?: number, stencilTest?: boolean): void {
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    if (!this.vmDraw) return;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    this.vmDraw();
    renderer.autoClear = prev;
    renderer.setRenderTarget(null);
  }
}

function makeComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    camera: THREE.PerspectiveCamera, modes: RenderModes) {
  const { bloomEnabled, postproEnabled, pmode, dirtOff } = modes;
  const bloomEffect = new SafeBloomEffect({
    mipmapBlur: true,
    // HDR linear frame: authored/emitting pixels sit at or above ~1
    // luminance (sun disc runs far past it) — 1.2 + a wide knee keeps
    // bloom on emitters and off the fogged horizon band.
    // Most scene content peaks at fog/sky luminance ~0.9-1.1 even in HDR
    // linear — 1.2 clears the horizon band while catching fading emitter
    // pixels; the mipmap halo can't lift the whole frame into a veil.
    luminanceThreshold: 1.3,
    luminanceSmoothing: 0.25,
    intensity: 1.25,
    radius: 0.5,
  });

  const upscaleEffect = new Effect('EdgeUpscale', UPSCALE_GLSL, {
    blendFunction: BlendFunction.NORMAL,
    uniforms: new Map<string, THREE.Uniform>([
      ['lowTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
      ['mode', new THREE.Uniform(1)],
    ]),
  });

  const acesGradeEffect = new Effect('ACESGrade', ACES_GLSL);

  // HDR linear buffers: three skips toneMapping AND output encoding when
  // rendering into a render target (WebGLPrograms gates on
  // currentRenderTarget===null), so the composer chain is responsible for
  // grading — acesPass replicates the canvas path's ACES exactly. Every
  // custom shader carries tonemapping_fragment/colorspace_fragment, so
  // the two paths stay pixel-consistent instead of double-encoding.
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  const scenePass = new VmRenderPass(scene, camera);
  composer.addPass(scenePass);

  // NaN/Inf guard before the mip chain: a single Inf texel (additive
  // stacks over the fp16 ceiling) turns to NaN inside bloom's blur and
  // upsamples into a full-frame black flash. Cheap fullscreen fix —
  // also strips NaNs already baked in by scene shaders.
  const sanitizePass = new EffectPass(camera, new Effect('HdrSanitize', SANITIZE_GLSL));
  composer.addPass(sanitizePass);

  // Bloom reads the raw linear frame, before the ACES grade clamps it to
  // display range — HDR luminance is what makes the threshold selective.
  const bloomMergePass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomMergePass);

  // Second NaN/Inf guard AFTER bloom: the merge's own luminance mip chain
  // can emit a bad texel even with clean input (internal blur/upsample
  // arithmetic), and lens dirt + ACES then smear it into a black frame.
  // Cheap insurance — folds any bloom-side NaN back to a clean pixel.
  const postBloomSanitize = new EffectPass(camera, new Effect('HdrSanitize2', SANITIZE_GLSL));
  composer.addPass(postBloomSanitize);

  // Lens dirt rides the bloom toggle — without bloom there's no halo for
  // the dirt to diffract, so a dirt-only frame would do nothing.
  // 1k AVIF (28KB) — the 4k/5MB source is wasteful for a screen-fit
  // multiplier mask; artifacts are invisible inside additive glow.
  const dirtTex = new THREE.TextureLoader().load('/assets/LensDirt/LensDirt03_1k.avif');
  const dirtEffect = new Effect('LensDirt', LENS_DIRT_GLSL, {
    uniforms: new Map<string, THREE.Uniform>([
      ['dirtMap', new THREE.Uniform(dirtTex)],
      ['dirtIntensity', new THREE.Uniform(3.0)], // 03 is a dark map — needs the boost to read
      ['dirtThreshold', new THREE.Uniform(1.15)], // under the 1.3 bloom gate so halo shoulders count
    ]),
  });
  const dirtPass = new EffectPass(camera, dirtEffect);
  composer.addPass(dirtPass);

  const acesPass = new EffectPass(camera, acesGradeEffect);
  composer.addPass(acesPass);

  const contrastPass = new EffectPass(camera, new BrightnessContrastEffect({ contrast: 0.06 }));
  composer.addPass(contrastPass);

  // Pixelated mode: scene renders at 1/PIXEL_SCALE into the composer buffer,
  // then this pass upscales to the full-res canvas with edge-aware blending.
  const upscalePass = new EffectPass(camera, upscaleEffect);
  composer.addPass(upscalePass);

  // xBR-lv2 pass — real edge-rule upscale for the fractional-degrade path
  // (FILTER: XBR). Sits after the lite upscaler in the chain; only one of
  // the two is ever enabled.
  const xbrEffect = new Effect('XBRlv2', XBR_GLSL, {
    blendFunction: BlendFunction.NORMAL,
    uniforms: new Map<string, THREE.Uniform>([
      ['lowTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
      ['xbrScale', new THREE.Uniform(1)],
    ]),
  });
  const xbrPass = new EffectPass(camera, xbrEffect);
  composer.addPass(xbrPass);

  // AA runs LAST — on the display-res frame after the upscale passes, so
  // it smooths real output edges (post-tonemap LDR is what FXAA/SMAA are
  // designed for). MSAA isn't a pass at all: it multisamples the composer
  // buffer itself.
  const fxaaPass = new EffectPass(camera, new FXAAEffect());
  const smaaPass = new EffectPass(camera, new SMAAEffect());
  composer.addPass(fxaaPass);
  composer.addPass(smaaPass);
  fxaaPass.enabled = false;
  smaaPass.enabled = false;

  bloomMergePass.enabled = bloomEnabled;
  dirtPass.enabled = bloomEnabled && !dirtOff;
  contrastPass.enabled = postproEnabled;
  upscalePass.enabled = pmode === 2; // dithered; upscalePass is Bayer-only now — smooth runs the xBR pass
  upscaleEffect.uniforms.get('mode')!.value = 2;
  xbrPass.enabled = false;

  // postprocessing's autoRenderToScreen only flags the LAST pass in the
  // array — upscalePass — so disabling it (every non-pixelated mode)
  // leaves no pass writing to the canvas: the whole composer rendered
  // black. The last ENABLED pass must carry the flag; re-sync on every
  // toggle, not just construction.
  function syncRenderToScreen(): void {
    const passes = composer.passes;
    let found = false;
    for (let i = passes.length - 1; i >= 0; i--) {
      const p = passes[i]!;
      p.renderToScreen = !found && p.enabled;
      if (p.renderToScreen) found = true;
    }
  }
  // fps-aa: 0 off / 1 FXAA / 2 SMAA / 3 MSAA2x / 4 MSAA4x — MSAA rebuilds
  // the multisampled buffer via the composer's setter, the rest toggle a
  // pass. syncRenderToScreen must re-run since the tail pass changed.
  function applyAA(v: number): void {
    fxaaPass.enabled = v === 1;
    smaaPass.enabled = v === 2;
    composer.multisampling = v === 3 ? 2 : v === 4 ? 4 : 0;
    syncRenderToScreen();
  }

  syncRenderToScreen();

  // Alt+Q census — enabled flag + which pass currently owns the screen
  // blit. The chain is static so labels can be hardcoded in order.
  const dumpPasses = () => ([
    ['scene', scenePass], ['sanitize', sanitizePass], ['bloom', bloomMergePass],
    ['sanitize2', postBloomSanitize], ['dirt', dirtPass], ['aces', acesPass],
    ['contrast', contrastPass], ['upscale', upscalePass], ['xbr', xbrPass],
    ['fxaa', fxaaPass], ['smaa', smaaPass],
  ] as [string, Pass][]).map(([n, p]) => `${n}${p.enabled ? '' : ':off'}${p.renderToScreen ? '>SCR' : ''}`);

  return { composer, scenePass, bloomMergePass, postBloomSanitize, dirtPass, contrastPass, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA, dumpPasses };
}

// Canvas sizing for every pixel/res path — hard modes render into a
// shrunken GL canvas (CSS upscale), everything else scales the buffer
// via pixel ratio and lets the composer's upscale pass finish it.
interface SizingGetters { pscale: () => number; pmode: () => number;
  resScale: () => number; pixelRatio: () => number }
function makeUpdateRendererSize(renderer: THREE.WebGLRenderer,
    fsCanvas: HTMLCanvasElement, fs: ReturnType<typeof makeFloydEngine>,
    getters: SizingGetters): () => void {
  const { pscale, pmode, resScale, pixelRatio } = getters;
  return () => {
    // RAW/ATKINSON never touch the composer: render straight into a low-res
    // canvas and let CSS upscale it — colors are identical to direct
    // rendering by construction, and it's the cheapest path.
    if (applyPixelSize(renderer, fsCanvas, pscale(), pmode())) {
      if (pmode() === 3) { fsCanvas.width = renderer.domElement.width; fsCanvas.height = renderer.domElement.height; fs.alloc(fsCanvas.width, fsCanvas.height); }
      return;
    }
    // Canvas stays full-res — in smooth mode only the composer buffers
    // drop to 1/PIXEL_SCALE and the upscale pass reconstructs to screen.
    const { w, h } = overscanSize();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w, h);
    // Fractional degrade upscales a sub-res buffer through the same CSS
    // filter path — SHARP keeps deep rungs readable, SMOOTH hides mild ones.
    renderer.domElement.style.imageRendering =
      resScale() < 1 && settings.get('fps-filter') === 0 ? 'pixelated' : 'auto';
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
  };
}

// Segmented rows: one .active button per group, wired by data-v.
// Returns the mark function so live changes (auto-quality, setPixel)
// can re-light the current pick.
function wireSegRow(id: string, current: () => number,
    pick: (v: number) => void): (v: number) => void {
  const row = document.getElementById(id);
  const btns = row ? [...row.querySelectorAll('button')] : [];
  const mark = (v: number) => {
    for (const b of btns) b.classList.toggle('active', Number(b.dataset['v']) === v);
  };
  btns.forEach((b, i) => b.addEventListener('click', () => pick(Number(b.dataset['v'] ?? i))));
  mark(current());
  return mark;
}

// ANTIALIAS row: reads+persist fps-aa, applies the stored pick at boot.
// Lives at module level so createRenderer stays under the line cap.
function wireAARow(applyAA: (v: number) => void, onChange?: (v: number) => void): void {
  let aaMode = settings.get('fps-aa');
  applyAA(aaMode);
  onChange?.(aaMode);
  const mark = wireSegRow('aa-row', () => aaMode,
    (v) => { aaMode = v; settings.set('fps-aa', v); applyAA(v); onChange?.(v); mark(v); });
}

// ESC-menu toggles: seed the toggle labels from resolved modes and
// return the buttons wired to the caller's callbacks.
function wireToggleButtons(modes: RenderModes, onBm: () => void, onPp: () => void) {
  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  // Player-facing label is GLOW — "bloom" carries washed-out baggage and
  // ours is emitter-gated (trails/explosions), which is what glow means.
  bloomToggleBtn.classList.toggle('on', modes.bloomEnabled);
  postproToggleBtn.classList.toggle('on', modes.postproEnabled);
  bloomToggleBtn.addEventListener('click', onBm);
  postproToggleBtn.addEventListener('click', onPp);
  return { bloomToggleBtn, postproToggleBtn };
}

// Frame render: composer for everything except ATKINSON, which draws the
// scene onto the hidden low-res canvas and CPU-quantizes onto fsCanvas.
interface RenderCtx { pmode: () => number;
  fsOverlay: () => (() => void) | null; shadowTick: () => void;
  scenePass: VmRenderPass }
function makeRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    camera: THREE.PerspectiveCamera, composer: EffectComposer,
    fs: ReturnType<typeof makeFloydEngine>, ctx: RenderCtx): (dt?: number) => void {
  const { pmode, fsOverlay, shadowTick, scenePass } = ctx;
  return (dt?: number) => {
    shadowTick();
    scenePass.vmDraw = fsOverlay(); // viewmodel rides the composer buffer in every chain mode
    if (pmode() === 3) {
      renderer.render(scene, camera);
      fsOverlay()?.(); // viewmodel renders onto the hidden GL canvas pre-readback
      fs.quantize();
      return;
    }
    composer.render(dt);
  };
}

export function createRenderer(camera: THREE.PerspectiveCamera, scene: THREE.Scene): RendererSetup {
  seedPotatoDefaults();
  const modes = resolveModes();
  let pscale = modes.pscale;
  let pmode = modes.pmode;
  let postproEnabled = modes.postproEnabled;
  let bloomEnabled = modes.bloomEnabled;
  let aaMode = settings.get('fps-aa');

  // high-performance asks the browser to pick the dGPU on dual-GPU
  // machines — default lets the OS park us on the iGPU.
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });

  const fs = makeFloydEngine(renderer);
  const fsCanvas = fs.canvasEl;
  fsCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:none;pointer-events:none;z-index:0';
  document.body.appendChild(fsCanvas);
  let fsOverlay: (() => void) | null = null; // viewmodel pass, injected by gameLoop
  // auto-quality degrade — hard-pixel modes force 1 (integer grid).
  // ?res=0.5 pins a starting scale for headless degrade/filter testing.
  const resParam = urlParams.get('res');
  let resScale = resParam !== null ? Math.min(1, Math.max(0.25, parseFloat(resParam) || 1)) : 1;
  // Effective pixel mode: at PIXEL SCALE 1× there's no low-res buffer for
  // SMOOTH/DITHERED/ATKINSON to process, so they collapse to RAW. pmode
  // keeps the stored pick — bumping the scale restores it.
  const pmodeEff = (): number => (pscale > 1 ? pmode : 0);
  // Effective AA: in SMOOTH the display-res xBR tail sits mid-chain, so
  // FXAA/SMAA after it demote its output back into the low-res ping-pong
  // buffers — reads as strictly "less smooth". MSAA is different: it
  // multisamples the low-res buffer itself (pre-upscale AA), which is a
  // legitimate look in every mode, so only FXAA/SMAA get forced off.
  const aaEff = (): number => (pmodeEff() === 1 && (aaMode === 1 || aaMode === 2) ? 0 : aaMode);
  function getPixelRatio(): number {
    return pscale > 1 ? 1 : Math.min(window.devicePixelRatio, 2) * resScale;
  }

  const updateRendererSize = makeUpdateRendererSize(renderer, fsCanvas, fs,
    { pscale: () => pscale, pmode: pmodeEff, resScale: () => resScale,
      pixelRatio: getPixelRatio });

  updateRendererSize();
  // Skip the whole shadow-map raster when the scene opted out — the
  // second full-scene pass is the dominant fill cost on weak GPUs.
  renderer.shadowMap.enabled = urlParams.get('shadows') !== 'off' && settings.get('fps-shadows');
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  // Canonical 16:9 frame at every window shape: canvas oversized to cover
  // the window at GAME_ASPECT and center-cropped (see overscanSize).
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.left = '50%';
  renderer.domElement.style.top = '50%';
  renderer.domElement.style.transform = 'translate(-50%, -50%)';
  document.body.appendChild(renderer.domElement);

  const cc = makeComposer(renderer, scene, camera, modes);
  const { composer, scenePass, bloomMergePass, dirtPass, contrastPass, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA, dumpPasses } = cc;

  // composer.setSize() also resizes the canvas — set buffers first, then
  // restore whichever canvas sizing the pixel mode wants (it never shrinks).
  function applyBufferSizes(): void {
    // Post buffers track render res: composer pixel modes render at
    // 1/pscale; the plain path uses the fractional resScale.
    const div = pscale > 1 ? pscale : 1 / resScale;
    const { w: ow, h: oh } = overscanSize();
    const w = Math.floor(ow / div), h = Math.floor(oh / div);
    setFxBufferHeight(h); // point-sprite shaders scale on BUFFER height, not CSS
    composer.setSize(w, h);
    upscaleEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    xbrEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    xbrEffect.uniforms.get('xbrScale')!.value = ow / w;
    // xBR pass handles SMOOTH pixel mode (integer degrade) and the
    // FILTER:XBR fractional tier — either case feeds it a low-res buffer.
    upscalePass.enabled = pscale > 1 && pmodeEff() === 2;
    xbrPass.enabled = (pscale > 1 && pmodeEff() === 1) ||
      (resScale < 1 && pscale === 1 && settings.get('fps-filter') === 2);
    syncRenderToScreen();
    // composer.setSize() also resizes the canvas — restore whichever canvas
    // sizing the active pixel mode wants.
    updateRendererSize();
  }
  applyBufferSizes();

  // Half-rate shadow updates: the pass re-rasterizes every caster each
  // frame (~46% of the frame measured); one frame of lag is invisible.
  let shadowTick = 0; renderer.shadowMap.autoUpdate = false;

  const render = makeRender(renderer, scene, camera, composer, fs,
    { pmode: pmodeEff, fsOverlay: () => fsOverlay, scenePass,
      shadowTick: () => { if ((shadowTick++ & 1) === 0) renderer.shadowMap.needsUpdate = true; } });

  // Seg-row markers — assigned by wireSegRow below; setPixel fires them
  // so auto-quality steps re-light the row too.
  let markPscale: ((v: number) => void) | undefined;
  let markPmode: ((v: number) => void) | undefined;

  // persist=false for auto-quality steps: the stored keys are the
  // user's chosen baseline; the ladder may degrade below it but never
  // rewrites it.
  function setPixel(scale: number, mode: number, persist = true): void {
    pscale = Math.min(4, Math.max(1, scale));
    pmode = Math.min(3, Math.max(0, mode));
    if (persist) { settings.set('fps-pscale', pscale); settings.set('fps-pmode', pmode); }
    syncRenderToScreen();
    // ATKINSON bypasses the composer entirely — bloom/post have no
    // pipeline to live in there, so opting into it drops them.
    if (pmodeEff() === 3) {
      if (postproEnabled) setPostProcessingEnabled(false);
      if (bloomEnabled) setBloomEnabled(false);
    }
    updateRendererSize();
    applyBufferSizes();
    markPscale?.(pscale);
    markPmode?.(pmode);
    applyAA(aaEff()); // AA is re-evaluated — non-RAW modes force it off
    syncPmodeLocks();
    syncAALocks();
  }

  // At 1× the non-RAW buttons are dead options (no low-res buffer to
  // process) — gray them out; the stored pick survives for scale-up.
  function syncPmodeLocks(): void {
    const locked = pscale <= 1;
    const row = document.getElementById('pmode-row');
    row?.querySelectorAll('button').forEach((b) => {
      const v = Number(b.dataset['v'] ?? 0);
      b.disabled = locked && v > 0;
      // Locked reads as RAW — a dimmed active SMOOTH would read "still on".
      // Unlock restores the stored pick's highlight.
      b.classList.toggle('active', locked ? v === 0 : v === pmode);
    });
  }

  // SMOOTH can't honor post-chain AA without degrading xBR output (see
  // aaEff) — gray out FXAA/SMAA; MSAA stays live (it's pre-upscale, not a
  // mid-chain pass). Locked reads as OFF so an armed-but-dead pick
  // doesn't display as active.
  function syncAALocks(): void {
    const locked = pmodeEff() === 1;
    const row = document.getElementById('aa-row');
    row?.querySelectorAll('button').forEach((b) => {
      const v = Number(b.dataset['v'] ?? 0);
      b.disabled = locked && (v === 1 || v === 2);
      b.classList.toggle('active', v === aaEff());
    });
  }

  function setResScale(scale: number): void {
    resScale = Math.min(1, Math.max(0.25, scale));
    updateRendererSize();
    applyBufferSizes();
  }

  function setPostProcessingEnabled(enabled: boolean): void {
    // Floyd mode has no composer — enabling post there drops floyd rather
    // than silently refusing (the toggle used to clamp back to OFF with
    // no feedback and read as dead). Other pixel modes share the chain.
    if (enabled && pmodeEff() === 3) setPixel(pscale, 0, false); // compat drop, not a user pick
    postproEnabled = enabled;
    settings.set('fps-postpro', postproEnabled);
    contrastPass.enabled = postproEnabled;
    syncRenderToScreen();
    postproToggleBtn.classList.toggle('on', postproEnabled);
  }

  function setBloomEnabled(enabled: boolean): void {
    // Same story as post — only atkinson is exclusive.
    if (enabled && pmodeEff() === 3) setPixel(pscale, 0, false);
    bloomEnabled = enabled;
    settings.set('fps-bloom', bloomEnabled);
    bloomMergePass.enabled = bloomEnabled;
    dirtPass.enabled = bloomEnabled && !modes.dirtOff;
    syncRenderToScreen();
    bloomToggleBtn.classList.toggle('on', bloomEnabled);
  }

  function resize(_width: number, _height: number): void {
    applyBufferSizes();
  }

  // Setup window resize handler
  window.addEventListener('resize', () => { camera.aspect = GAME_ASPECT; camera.updateProjectionMatrix(); applyBufferSizes(); });

  const { bloomToggleBtn, postproToggleBtn } = wireToggleButtons(modes,
    () => setBloomEnabled(!bloomEnabled),
    () => setPostProcessingEnabled(!postproEnabled));

  // applyBufferSizes (not just updateRendererSize): pixel/composer
  // pass enables are only re-evaluated on that path.
  markPscale = wireSegRow('pscale-row', () => pscale,
    (v) => setPixel(v, pmode));
  markPmode = wireSegRow('pmode-row', () => pmode,
    (v) => setPixel(pscale, v));
  syncPmodeLocks(); // boot: 1× scale starts with non-RAW locked
  // applyAA wrapper takes the picked v (wireAARow calls it before onChange
  // updates our aaMode) — clamps to 0 whenever a non-RAW mode is live.
  wireAARow((v) => applyAA(pmodeEff() === 1 && (v === 1 || v === 2) ? 0 : v), (v) => { aaMode = v; });
  syncAALocks(); // boot: non-RAW pixel mode starts with AA locked

  // AA>0 pulls the composer in even with post+glow off — FXAA/SMAA are
  // composer passes and MSAA is its buffer flag; without this the whole
  // ANTIALIAS row silently no-ops on the direct-render path.
  const needsComposerNow = () => (pscale > 1 && (pmode === 1 || pmode === 2)) || bloomEnabled || postproEnabled ||
    aaEff() > 0 || (resScale < 1 && pscale === 1 && settings.get('fps-filter') === 2);

  // Alt+Q render census — the pipeline state that produced the frame:
  // pixel-mode picks (stored vs effective), AA pick + MSAA buffer flag,
  // composer buffer vs canvas size (the low-res mismatch that demotes
  // mid-chain passes), tonemapping, and the enabled-pass chain.
  window.__renderDump = () => ({
    pscale, pmode, pmodeEff: pmodeEff(), resScale,
    aa: aaMode, aaEff: aaEff(), msaa: composer.multisampling,
    buffer: `${composer.inputBuffer.width}x${composer.inputBuffer.height}`,
    canvas: `${renderer.domElement.width}x${renderer.domElement.height}@${renderer.getPixelRatio()}`,
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    bloom: bloomEnabled, postpro: postproEnabled,
    composerOn: needsComposerNow(),
    passes: dumpPasses(),
  });

  return {
    renderer,
    composer,
    bloomPass: bloomMergePass,
    contrastPass,
    render,
    needsComposer: needsComposerNow,
    setOverlayPass: (fn) => { fsOverlay = fn; },
    isFloyd: () => pmodeEff() === 3,
    isPostProcessingEnabled: () => postproEnabled,
    isBloomEnabled: () => bloomEnabled,
    setBloomEnabled,
    updateRendererSize,
    // checkMaterialsReady throws inside three when a material added
    // mid-compile never receives a currentProgram — benign, but the
    // rejection was surfacing as a pageerror in probes.
    warmup: () => { void renderer.compileAsync(scene, camera).catch(() => { /* late-added material */ }); },
    setPixel,
    setResScale,
    setPostProcessingEnabled,
    resize,
  };
}
