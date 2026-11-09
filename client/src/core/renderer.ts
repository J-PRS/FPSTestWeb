import * as THREE from 'three';
import { settings } from './settings.js';
import { urlParams } from './params.js';
import { gpuPassInit, gpuPassDrain, gpuPassReport, gpuPassWrap } from './gpuPassTimer.ts';
import {
  type Pass,
  Effect,
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  BrightnessContrastEffect,
  BlendFunction,
  FXAAEffect,
  SMAAEffect,
} from 'postprocessing';
import {
  TONE_MAPPING_EXPOSURE,
} from './config.js';
import { UPSCALE_GLSL, XBR_GLSL, ACES_GLSL, LENS_DIRT_GLSL, SANITIZE_GLSL, BLOOM_MERGE_GLSL, RETRO_GLSL } from './rendererShaders.js';
import { setFxBufferHeight } from './fxViewport.js';

export interface RendererSetup {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: EffectPass;
  gradePass: EffectPass;
  render: (dt?: number) => void;
  needsComposer: () => boolean;
  /** FLOYD mode: extra draw onto the GL canvas between scene render and the
   *  readPixels (the viewmodel pass - otherwise the gun vanishes in FS). */
  setOverlayPass: (fn: (() => void) | null) => void;
  isFloyd: () => boolean;
  isPostProcessingEnabled: () => boolean;
  isBloomEnabled: () => boolean;
  setBloomEnabled: (enabled: boolean) => void;
  updateRendererSize: () => void;
  /** Compile every scene material chunked across frames so programs
   *  don't lazily stall their first draw (or monolithically stall one
   *  boot frame - compileAsync's link+introspection is serial). */
  warmup: () => void;
  /** Retro pixel pipeline as two axes: integer size divisor (1-4) and
   *  mode (0 raw / 1 smooth-xBR / 2 dithered / 3 atkinson). scale=1
   *  disables the pipeline entirely. */
  setPixel: (scale: number, mode: number, persist?: boolean) => void;
  /** Retro post pass: color steps per channel; 0 = off. */
  applyRetro: (lv: number) => void;
  /** Fractional resolution scale (auto-quality degrade) - softens the
   *  frame evenly via pixel-ratio scaling; only meaningful outside the
   *  hard-pixel modes, which need integer factors to keep the chunky
   *  grid regular. */
  setResScale: (scale: number) => void;
  setPostProcessingEnabled: (enabled: boolean, persist?: boolean) => void;
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
// Adreno needs no version gate - every Adreno is a mobile tile-GPU
// (the old 0-5xx bound predates 6xx/7xx parts that dominate today).
const WEAK_GL = /swiftshader|llvmpipe|software|intel.*(hd|uhd)\s?graphics|mali|adreno|videocore|apple gpu/i;
function detectWeakGpu(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) {return true;} // no GL at all - deepest tier either way
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return WEAK_GL.test(r);
  } catch { return false; }
}
function seedPotatoDefaults(): void {
  if (settings.has('fps-pixelated') || settings.has('fps-pscale') || settings.has('fps-shadows')) {return;}
  if (!detectWeakGpu()) {return;}
  settings.set('fps-pscale', 4);
  settings.set('fps-shadows', false);
  // Bloom's multi-pass luminance chain is the mobile-tile-GPU killer;
  // the fused grade pass (tone map) is one fullscreen shader - keep it,
  // postpro OFF would strip the ACES look entirely (overexposed output).
  settings.set('fps-bloom', false);
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
  // Post-processing defaults ON (settings.ts). Override via the ESC menu,
  // localStorage, or ?postpro=off / ?bloom=off.
  let postproEnabled = settings.get('fps-postpro');
  let bloomEnabled = settings.get('fps-bloom');
  // URL overrides for headless screenshots/testing
  const px = urlParams.get('pixelated');
  if (px !== null && px in PX_MODES) {[pscale, pmode] = LEGACY_PM[PX_MODES[px]!] ?? [1, 0];}
  const ps = urlParams.get('pscale');
  if (ps !== null) {pscale = Math.min(8, Math.max(0.5, Number.parseFloat(ps) || 1));}
  const pm = urlParams.get('pmode');
  if (pm !== null) {pmode = Math.min(3, Math.max(0, Number.parseInt(pm, 10) || 0));}
  const pp = urlParams.get('postpro');
  if (pp !== null) {postproEnabled = pp === 'on';}
  const bm = urlParams.get('bloom');
  if (bm !== null) {bloomEnabled = bm === 'on';}
  // Atkinson bypasses the composer entirely (GL render → CPU quantize),
  // so postpro/bloom can never engage under it - suppress dead toggles.
  if (pmode === 3) {
    postproEnabled = false;
    bloomEnabled = false;
  }
  // ?dirt=off - isolates the lens-dirt stage when bisecting the
  // black-frame NaN smear (bloom stays on, dirt never samples it).
  const dirtOff = urlParams.get('dirt') === 'off';
  return { pscale, pmode, postproEnabled, bloomEnabled, dirtOff };
}

const FS_LEVELS = 6; // per-channel quantization - 4 was chroma-noise soup

// ---- Floyd-Steinberg mode (5): real CPU error diffusion ----
// GL canvas renders at hard-mode scale but stays hidden; each frame we
// readPixels → F-S quantize in JS → putImageData to this 2D canvas which
// CSS upscales. Costs a few ms + one pipeline stall per frame - that's
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
    if (!w || !h || !buf || !img) {return;}
    const gl = renderer.getContext();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const src = buf, dst = img.data, step = 255 / (FS_LEVELS - 1);
    for (let y = 0; y < h; y += 1) {
      const cur = errA; errA = errB; errB = cur; errB.fill(0);
      ditherRow(y, src, dst, w, h, step);
    }
    ctx2d.putImageData(img, 0, 0);
  }

  /** One serpentine row of quantize + error push - extracted so
   *  quantize() isn't carrying the per-channel conditionals. errA/errB
   *  (and their swap) live on the engine closure. */
  function ditherRow(y: number, src: Uint8ClampedArray, dst: Uint8ClampedArray,
      w: number, h: number, step: number): void {
    const srcRow = (h - 1 - y) * w * 4; // GL rows are bottom-up - flip here
    const dstRow = y * w * 4;
    // Serpentine: alternate scan direction per row - pure raster order
    // smears error one way and leaves diagonal worm artifacts
    const fwd = (y & 1) === 0;
    const ahead = fwd ? 3 : -3, behind = -ahead;
    for (let xi = 0; xi < w; xi += 1) {
      const x = fwd ? xi : w - 1 - xi;
      const si = srcRow + x * 4, di = dstRow + x * 4, ei = x * 3;
      for (let c = 0; c < 3; c += 1) {
        const v = src[si + c] + errA[ei + c];
        let q = Math.round(v / step) * step;
if (v < 0) {q = 0;}
else if (v > 255) {q = 255;}
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
// definition - that's the retro look) and ATKINSON (hidden GL feed for
// the CPU dither canvas). Composer modes (smooth/dithered) keep a
// full-res canvas and shrink buffers instead. Returns true when the
// canvas was shrunk. GL canvas MUST stay visible - pointer lock targets
// it; fsCanvas is pointer-events:none.
// The world renders a canonical 16:9 frame at every window shape: the
// canvas is oversized to cover the window at that aspect and CSS
// center-crops it, so a non-16:9 window crops (never squashes) the same
// frame - every player sees identical vertical FOV, and video capture of
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
  // pscale<1 = 2× supersample: render a bigger buffer, CSS downsamples it
  // (bilinear is right here - this path exists for fill-rate profiling,
  // not a crispness pick). Same math: w/0.5 = 2w.
  if (pscale === 1 || (pmode !== 0 && pmode !== 3)) {return false;}
  const { w, h } = overscanSize();
  renderer.setPixelRatio(1);
  // pscale<1 supersampling can overrun MAX_TEXTURE_SIZE the same way the
  // pixelRatio path can - floor the scale so the buffer always fits.
  const maxTex = renderer.capabilities.maxTextureSize;
  const scale = Math.max(pscale, w / maxTex, h / maxTex);
  renderer.setSize(Math.floor(w / scale),
    Math.floor(h / scale), false);
  renderer.domElement.style.imageRendering = pscale < 1 ? 'auto' : 'pixelated';
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
  return true;
}


// Whole-scene bloom gated by a luminance threshold: emitters (trails,
// explosions, nuggets) push the brightest colors, the lit terrain and sky
// stay under it, so bloom never washes the frame. (A second composer and
// SelectiveBloomEffect both proved fragile here - keep the simple one.)
// SafeBloomEffect: same BloomEffect, but the merge shader zeroes
// non-finite bloom-texture samples instead of letting a NaN write black
// through the SCREEN blend - see BLOOM_MERGE_GLSL.
class SafeBloomEffect extends BloomEffect {
  constructor(opts: ConstructorParameters<typeof BloomEffect>[0]) {
    super(opts);
    this.setFragmentShader(BLOOM_MERGE_GLSL);
  }
}
// Viewmodel-aware scene pass - the gun scene draws into the same frame
// buffer right after the world (depth cleared, color kept), so the WHOLE
// chain downstream treats it as scene content: bloom, grade, and the
// smooth/dithered upscale. Without this the viewmodel was composited on
// canvas after the composer - full-res and unprocessed on a chunky frame.
class VmRenderPass extends RenderPass {
  /** Draw hook - the same overlay fn floyd injects pre-readback. */
  vmDraw: (() => void) | null = null;
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null,
      outputBuffer: THREE.WebGLRenderTarget | null, deltaTime?: number, stencilTest?: boolean): void {
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    if (!this.vmDraw) {return;}
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
    // HDR linear frame: authored/emitting pixels sit at or above ~2
    // luminance (sun disc runs far past it) - the threshold's job is to
    // isolate emitters, intensity does the drama. Most scene content peaks
    // at fog/sky ~0.9-1.1, but snow albedo (0.98) × sun+rim lights to ~1.4
    // - 1.5 keeps Whiteout's whole field from blooming at intensity 5
    // while stacked-additive emitters still clear the gate.
    luminanceThreshold: 1.3,
    luminanceSmoothing: 0.25,
    intensity: 5, // Was 1.25
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
  // grading - acesPass replicates the canvas path's ACES exactly. Every
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
  // upsamples into a full-frame black flash. Cheap fullscreen fix -
  // also strips NaNs already baked in by scene shaders.
  const sanitizePass = new EffectPass(camera, new Effect('HdrSanitize', SANITIZE_GLSL));
  composer.addPass(sanitizePass);

  // Bloom reads the raw linear frame, before the ACES grade clamps it to
  // display range - HDR luminance is what makes the threshold selective.
  const bloomMergePass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomMergePass);

  // Second NaN/Inf guard AFTER bloom: the merge's own luminance mip chain
  // can emit a bad texel even with clean input (internal blur/upsample
  // arithmetic), and lens dirt + ACES then smear it into a black frame.
  // Cheap insurance - folds any bloom-side NaN back to a clean pixel.
  const postBloomSanitize = new Effect('HdrSanitize2', SANITIZE_GLSL);

  // Lens dirt rides the bloom toggle - without bloom there's no halo for
  // the dirt to diffract, so a dirt-only frame would do nothing.
  // 1k AVIF (28KB) - the 4k/5MB source is wasteful for a screen-fit
  // multiplier mask; artifacts are invisible inside additive glow.
  const dirtTex = new THREE.TextureLoader().load('/assets/LensDirt/LensDirt03_1k.webp');
  const dirtEffect = new Effect('LensDirt', LENS_DIRT_GLSL, {
    uniforms: new Map<string, THREE.Uniform>([
      ['dirtMap', new THREE.Uniform(dirtTex)],
      // Unity-style: dirt × the isolated bloom composite. BloomEffect's
      // .texture IS its mip-chain output RT - the dirt pass runs after
      // bloomMerge so it's already filled. Fog can't fake it: the bloom
      // buffer only holds light that cleared the 1.3 gate.
      ['bloomTex', new THREE.Uniform(bloomEffect.texture)],
      ['dirtIntensity', new THREE.Uniform(3)],
    ]),
  });
  // One fused grade pass - EffectPass compiles all its effects into a
  // single fullscreen shader, so sanitize+dirt+aces+contrast cost ONE
  // buffer roundtrip instead of four. Shed-at-deep-tier disables the
  // whole pass, which was already the intent for dirt+contrast; losing
  // aces there too is the same "raw output" story.
  const gradePass = new EffectPass(camera, postBloomSanitize, dirtEffect, acesGradeEffect, new BrightnessContrastEffect({ contrast: 0.06 }));
  gradePass.name = 'GradePass';
  composer.addPass(gradePass);

  // Pixelated mode: scene renders at 1/PIXEL_SCALE into the composer buffer,
  // then this pass upscales to the full-res canvas with edge-aware blending.
  const upscalePass = new EffectPass(camera, upscaleEffect);
  composer.addPass(upscalePass);

  // xBR-lv2 pass - real edge-rule upscale for the fractional-degrade path
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

  // AA runs LAST - on the display-res frame after the upscale passes, so
  // it smooths real output edges (post-tonemap LDR is what FXAA/SMAA are
  // designed for). MSAA isn't a pass at all: it multisamples the composer
  // buffer itself.
  const fxaaPass = new EffectPass(camera, new FXAAEffect());
  const smaaPass = new EffectPass(camera, new SMAAEffect());
  composer.addPass(fxaaPass);

  // ?gpuperf: wrap every composer pass in a GPU timer query so the
  // harness reads per-pass GPU ms - the honest version of 'which pass
  // costs what'. Inert otherwise (queries only issue under the flag).
  if (urlParams.get('gpuperf') === '1' && gpuPassInit(renderer)) {
    for (const pass of composer.passes) {
      // EffectPass.name is just 'EffectPass' - the EFFECT inside names
      // the work ('ACESGrade', 'LensDirt'). Multi-effect passes join.
      const {effects} = (pass as { effects?: { name: string }[] });
      const label = effects?.length
        ? effects.map((e) => e.name).join('+')
        : ((pass as { name?: string }).name ?? pass.constructor.name);
      pass.render = gpuPassWrap(label, pass.render.bind(pass));
    }
    (window as unknown as Record<string, unknown>).__gpuPass = gpuPassReport;
  }
  composer.addPass(smaaPass);
  fxaaPass.enabled = false;
  smaaPass.enabled = false;

  // Retro - palette quantize only (pixel size lives in the PIXEL SIZE
  // row), display-space, dead last. levels 0 = pass-through; the pass is
  // enabled but no-ops so toggling never re-orders the chain.
  const retroEffect = new Effect('Retro', RETRO_GLSL, {
    uniforms: new Map<string, THREE.Uniform>([['levels', new THREE.Uniform(0)]]),
  });
  const retroPass = new EffectPass(camera, retroEffect);
  composer.addPass(retroPass);
  /** lv>0 = color steps per channel (256/64/16/8 presets). */
  function applyRetro(lv: number): void {
    retroEffect.uniforms.get('levels')!.value = lv;
  }

  bloomMergePass.enabled = bloomEnabled;
  gradePass.enabled = postproEnabled;
  dirtEffect.uniforms.get('dirtIntensity')!.value = bloomEnabled && !dirtOff ? 3 : 0;
  upscalePass.enabled = pmode === 2; // dithered; upscalePass is Bayer-only now - smooth runs the xBR pass
  upscaleEffect.uniforms.get('mode')!.value = 2;
  xbrPass.enabled = false;

  // postprocessing's autoRenderToScreen only flags the LAST pass in the
  // array - upscalePass - so disabling it (every non-pixelated mode)
  // leaves no pass writing to the canvas: the whole composer rendered
  // black. The last ENABLED pass must carry the flag; re-sync on every
  // toggle, not just construction.
  function syncRenderToScreen(): void {
    const {passes} = composer;
    let found = false;
    for (let i = passes.length - 1; i >= 0; i -= 1) {
      const p = passes[i]!;
      p.renderToScreen = !found && p.enabled;
      if (p.renderToScreen) {found = true;}
    }
  }
  // fps-aa: 0 off / 1 FXAA / 2 SMAA / 3 MSAA2x / 4 MSAA4x - MSAA rebuilds
  // the multisampled buffer via the composer's setter, the rest toggle a
  // pass. syncRenderToScreen must re-run since the tail pass changed.
  function applyAA(v: number): void {
    // MSAA hidden: its composer-buffer resolve paints black speckle
    // artifacts (worst at low res) - a stored MSAA pick behaves as SMAA.
    if (v >= 3) {v = 2;}
    fxaaPass.enabled = v === 1;
    smaaPass.enabled = v === 2;
    composer.multisampling = 0;
    syncRenderToScreen();
  }

  syncRenderToScreen();

  // Alt+Q census - enabled flag + which pass currently owns the screen
  // blit. The chain is static so labels can be hardcoded in order.
  const dumpPasses = (): string[] => ([
    ['scene', scenePass], ['sanitize', sanitizePass], ['bloom', bloomMergePass],
    ['grade', gradePass], ['upscale', upscalePass], ['xbr', xbrPass],
    ['fxaa', fxaaPass], ['smaa', smaaPass], ['retro', retroPass],
  ] as [string, Pass][]).map(([n, p]): string => `${n}${p.enabled ? '' : ':off'}${p.renderToScreen ? '>SCR' : ''}`);

  return { composer, scenePass, bloomMergePass, gradePass, dirtEffect, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA, applyRetro, dumpPasses };
}

// Canvas sizing for every pixel/res path - hard modes render into a
// shrunken GL canvas (CSS upscale), everything else scales the buffer
// via pixel ratio and lets the composer's upscale pass finish it.
interface SizingGetters { pscale: () => number; pmode: () => number;
  resScale: () => number; pixelRatio: () => number }
function makeUpdateRendererSize(renderer: THREE.WebGLRenderer,
    fsCanvas: HTMLCanvasElement, fs: ReturnType<typeof makeFloydEngine>,
    getters: SizingGetters): () => void {
  const { pscale, pmode, resScale, pixelRatio } = getters;
  return (): void => {
    // RAW/ATKINSON never touch the composer: render straight into a low-res
    // canvas and let CSS upscale it - colors are identical to direct
    // rendering by construction, and it's the cheapest path.
    if (applyPixelSize(renderer, fsCanvas, pscale(), pmode())) {
      if (pmode() === 3) { fsCanvas.width = renderer.domElement.width; fsCanvas.height = renderer.domElement.height; fs.alloc(fsCanvas.width, fsCanvas.height); }
      return;
    }
    // Canvas stays full-res - in smooth mode only the composer buffers
    // drop to 1/PIXEL_SCALE and the upscale pass reconstructs to screen.
    const { w, h } = overscanSize();
    // Clamp pixel ratio so the drawing buffer fits the GPU: portrait
    // phones hit 16:9-overscan × dpr buffers past MAX_TEXTURE_SIZE and
    // present black. (composer buffers ride the same pixelRatio.)
    const maxTex = renderer.capabilities.maxTextureSize;
    renderer.setPixelRatio(Math.min(pixelRatio(), maxTex / w, maxTex / h));
    renderer.setSize(w, h);
    // Fractional degrade upscales a sub-res buffer through the same CSS
    // filter path - SHARP keeps deep rungs readable, SMOOTH hides mild ones.
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
  const mark = (v: number): void => {
    for (const b of btns) {b.classList.toggle('active', Number(b.dataset['v']) === v);}
  };
  btns.forEach((b, i): void => b.addEventListener('click', (): void => {
    pick(Number(b.dataset['v'] ?? i));
    mark(current()); // re-light from the picked state, not the raw index
  }));
  mark(current());
  return mark;
}

// ANTIALIAS row: reads+persist fps-aa, applies the stored pick at boot.
// Lives at module level so createRenderer stays under the line cap.
function wireAARow(applyAA: (v: number) => void, onChange?: (v: number) => void): void {
  let aaMode = settings.get('fps-aa');
  // MSAA picks are hidden (composer-buffer resolve paints black speckle
  // artifacts, worst at low res) - demote a stored MSAA pick to SMAA.
  if (aaMode >= 3) {aaMode = 2;}
  applyAA(aaMode);
  onChange?.(aaMode);
  wireSegRow('aa-row', (): number => aaMode,
    (v): void => { aaMode = v; settings.set('fps-aa', v); applyAA(v); onChange?.(v); });
}

// ESC-menu toggles: seed the toggle labels from resolved modes and
// return the buttons wired to the caller's callbacks.
function wireToggleButtons(modes: RenderModes, onBm: () => void, onPp: () => void): { bloomToggleBtn: HTMLButtonElement; postproToggleBtn: HTMLButtonElement; } {
  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  // Player-facing label is GLOW - "bloom" carries washed-out baggage and
  // ours is emitter-gated (trails/explosions), which is what glow means.
  bloomToggleBtn.classList.toggle('on', modes.bloomEnabled);
  postproToggleBtn.classList.toggle('on', modes.postproEnabled);
  bloomToggleBtn.addEventListener('click', onBm);
  postproToggleBtn.addEventListener('click', onPp);
  // Wake-cone shells are cosmetic only - pure settings flip, read per frame.
  const wakeToggleBtn = document.getElementById('wake-toggle')! as HTMLButtonElement;
  wakeToggleBtn.classList.toggle('on', settings.get('fps-wake'));
  wakeToggleBtn.addEventListener('click', (): void => {
    const v = !settings.get('fps-wake');
    settings.set('fps-wake', v);
    wakeToggleBtn.classList.toggle('on', v);
  });
  // Trail-isolation pair — cosmetic flags read per frame by the emit
  // paths; killing one half of the trail stack names the smearer.
  for (const [id, key] of [['ptrail-toggle', 'fps-ptrails'], ['rtrail-toggle', 'fps-ribbons'], ['dotrail-toggle', 'fps-dots'], ['wpos-toggle', 'fps-wpos']] as const) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) {continue;}
    btn.classList.toggle('on', settings.get(key));
    btn.addEventListener('click', (): void => {
      const v = !settings.get(key);
      settings.set(key, v);
      btn.classList.toggle('on', v);
    });
  }
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
  return (dt?: number): void => {
    gpuPassDrain(); // per-frame: fold finished GPU queries into stats
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
  let {pscale} = modes;
  let {pmode} = modes;
  let {postproEnabled} = modes;
  let {bloomEnabled} = modes;
  // MSAA hidden (see applyAA) - a stored 3/4 pick reports as SMAA.
  let aaMode = Math.min(settings.get('fps-aa'), 2);

  // high-performance asks the browser to pick the dGPU on dual-GPU
  // machines - default lets the OS park us on the iGPU.
  // A lost context is unrecoverable for three - every buffer/texture/
  // program died with it - so the standard recovery is a reload
  // (khronos wiki: re-create ALL resources; production three apps
  // reload). Creation can also fail while the GPU process is mid-reset
  // or after Chrome blocked the page for prior losses - same cure:
  // reload gets a fresh page (and a fresh loss budget). The 1s delay
  // lets a transient GPU churn settle instead of thrash-reloading.
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let renderer!: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch (error) {
    setTimeout((): void => window.location.reload(), 1000);
    throw error;
  }
  renderer.domElement.addEventListener('webglcontextlost', (e): void => {
    e.preventDefault();
    window.location.reload();
  });

  const fs = makeFloydEngine(renderer);
  const fsCanvas = fs.canvasEl;
  // No z-index anywhere: stack by DOM order - gl → fsCanvas → #hud -
  // so ATKINSON's 2D canvas covers the GL feed but sits under the HUD.
  // Appended after renderer.domElement below.
  fsCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:none;pointer-events:none';
  let fsOverlay: (() => void) | null = null; // viewmodel pass, injected by gameLoop
  // auto-quality degrade - hard-pixel modes force 1 (integer grid).
  // ?res=0.5 pins a starting scale for headless degrade/filter testing.
  const resParam = urlParams.get('res');
  let resScale = resParam === null ? 1 : Math.min(1, Math.max(0.25, Number.parseFloat(resParam) || 1));
  // Effective pixel mode: at PIXEL SCALE 1× there's no low-res buffer for
  // SMOOTH/DITHERED/ATKINSON to process, so they collapse to RAW. pmode
  // keeps the stored pick - bumping the scale restores it.
  const pmodeEff = (): number => (pscale > 1 ? pmode : 0);
  // Effective AA: in SMOOTH the display-res xBR tail sits mid-chain, so
  // FXAA/SMAA after it demote its output back into the low-res ping-pong
  // buffers - reads as strictly "less smooth". MSAA is different: it
  // multisamples the low-res buffer itself (pre-upscale AA), which is a
  // legitimate look in every mode, so only FXAA/SMAA get forced off.
  const aaEff = (): number => (pmodeEff() === 1 && (aaMode === 1 || aaMode === 2) ? 0 : aaMode);
  function getPixelRatio(): number {
    return pscale > 1 ? 1 : Math.min(window.devicePixelRatio, 2) * resScale;
  }

  const updateRendererSize = makeUpdateRendererSize(renderer, fsCanvas, fs,
    { pscale: (): number => pscale, pmode: pmodeEff, resScale: (): number => resScale,
      pixelRatio: getPixelRatio });

  updateRendererSize();
  // Skip the whole shadow-map raster when the scene opted out - the
  // second full-scene pass is the dominant fill cost on weak GPUs.
  renderer.shadowMap.enabled = urlParams.get('shadows') !== 'off' && settings.get('fps-shadows');
  // r184 deprecated PCFSoftShadowMap: WebGLShadowMap mutates .type to
  // PCFShadowMap on the FIRST raster, so every material compiled before
  // it keyed SHADOWMAP_TYPE_BASIC (sampler2D) and then sampled the
  // depth-compare texture - GL_INVALID_OPERATION on every lit draw.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Skip the per-link infoLog query - lazy material variants compile
  // mid-match (new elites, tracers) and a live profile caught the
  // getProgramInfoLog validation stack at ~1.5% of the frame. Compile
  // still runs; only the log read is dropped. Dev sessions can flip it
  // back on with __renderer.debug.checkShaderErrors = true - or boot
  // with ?shadererrors=1 (debugging invalid-program spam).
  renderer.debug.checkShaderErrors = urlParams.get('shadererrors') === '1';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  // Canonical 16:9 frame at every window shape: canvas oversized to cover
  // the window at GAME_ASPECT and center-cropped (see overscanSize).
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.left = '50%';
  renderer.domElement.style.top = '50%';
  renderer.domElement.style.transform = 'translate(-50%, -50%)';
  renderer.domElement.id = 'gl'; // the underwater sway rule targets it
  document.body.append(renderer.domElement);
  document.body.append(fsCanvas); // after gl: DOM order = the z-order

  const cc = makeComposer(renderer, scene, camera, modes);
  const { composer, scenePass, bloomMergePass, gradePass, dirtEffect, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA, applyRetro, dumpPasses } = cc;

  // composer.setSize() also resizes the canvas - set buffers first, then
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
    // FILTER:XBR fractional tier - either case feeds it a low-res buffer.
    upscalePass.enabled = pscale > 1 && pmodeEff() === 2;
    xbrPass.enabled = (pscale > 1 && pmodeEff() === 1) ||
      (resScale < 1 && pscale === 1 && settings.get('fps-filter') === 2);
    syncRenderToScreen();
    // composer.setSize() also resizes the canvas - restore whichever canvas
    // sizing the active pixel mode wants.
    updateRendererSize();
  }
  applyBufferSizes();

  // Half-rate shadow updates: the pass re-rasterizes every caster each
  // frame (~46% of the frame measured); one frame of lag is invisible.
  let shadowTick = 0; renderer.shadowMap.autoUpdate = false;
  // Allocate sun.shadow.map in the FIRST render - lit materials (terrain,
  // instanced species) draw with sampler2DShadow bound to the 1x1 empty
  // texture until a raster exists, erroring per draw; seeding needsUpdate
  // before the first frame means the binding is real from draw one.
  if (renderer.shadowMap.enabled) {renderer.shadowMap.needsUpdate = true;}
  // Lit materials that compile before the lazy shadow-map allocation
  // exists keep directionalShadowMap bound to unit 0 - every one of
  // their draws then logs GL_INVALID_OPERATION (texture/sampler type
  // mismatch) forever. One needsUpdate pass after the first raster
  // rebinds them for the session; the cost hides inside boot warmup.
  // Late-compiled lit materials (tracers, elites, remote models pooled
  // mid-match) hit the same unit-0 binding - a one-shot traverse only
  // heals the boot set, and every later straggler errors per draw for
  // the session. Re-sweep every ~2s against the SAME seen-set: materials
  // already healed cost a Set lookup, only new compiles rebind.
  const litShadowSeen = new Set<THREE.Material>();
  let litShadowTick = 0;

  const render = makeRender(renderer, scene, camera, composer, fs,
    { pmode: pmodeEff, fsOverlay: (): (() => void) | null => fsOverlay, scenePass,
      shadowTick: (): void => {
        if ((((shadowTick += 1) - 1) & 1) === 0) {renderer.shadowMap.needsUpdate = true;}
        // The sweep heals even with shadows OFF: a material compiled
        // while the sampler2DShadow was bound keeps erroring per draw,
        // and needsUpdate recompiles it against the now-shadowless
        // light set - dropping the dead binding outright.
        if (shadowTick > 4 && (litShadowTick += 1) % 120 === 1) {
          scene.traverse((o): void => {
            const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
            if (!m) {return;}
            const list = Array.isArray(m) ? m : [m];
            for (const mm of list) {
              if (litShadowSeen.has(mm)) {continue;}
              litShadowSeen.add(mm);
              if ((mm as THREE.ShaderMaterial).isShaderMaterial ||
                  (mm as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
                  (mm as THREE.MeshPhongMaterial).isMeshPhongMaterial ||
                  (mm as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
                  (mm as THREE.MeshToonMaterial).isMeshToonMaterial) {
                mm.needsUpdate = true;
              }
            }
          });
        }
      } });

  // Seg-row markers - assigned by wireSegRow below; setPixel fires them
  // so auto-quality steps re-light the row too.
  let markPscale: ((v: number) => void) | undefined = undefined;
  let markPmode: ((v: number) => void) | undefined = undefined;

  // persist=false for auto-quality steps: the stored keys are the
  // user's chosen baseline; the ladder may degrade below it but never
  // rewrites it.
  function setPixel(scale: number, mode: number, persist = true): void {
    pscale = Math.min(8, Math.max(0.5, scale)); // 0.5 = 2× supersample (dev probe)
    pmode = Math.min(3, Math.max(0, mode));
    if (persist) { settings.set('fps-pscale', pscale); settings.set('fps-pmode', pmode); }
    syncRenderToScreen();
    // ATKINSON bypasses the composer entirely - bloom/post have no
    // pipeline to live in there, so opting into it drops them.
    if (pmodeEff() === 3) {
      if (postproEnabled) {setPostProcessingEnabled(false);}
      if (bloomEnabled) {setBloomEnabled(false);}
    }
    updateRendererSize();
    applyBufferSizes();
    markPscale?.(pscale);
    markPmode?.(pmode);
    applyAA(aaEff()); // AA is re-evaluated - non-RAW modes force it off
    syncPmodeLocks();
    syncAALocks();
  }

  // At 1× the non-RAW buttons are dead options (no low-res buffer to
  // process) - gray them out; the stored pick survives for scale-up.
  function syncPmodeLocks(): void {
    const locked = pscale <= 1;
    const row = document.getElementById('pmode-row');
    row?.querySelectorAll('button').forEach((b): void => {
      const v = Number(b.dataset['v'] ?? 0);
      b.disabled = locked && v > 0;
      // Locked reads as RAW - a dimmed active SMOOTH would read "still on".
      // Unlock restores the stored pick's highlight.
      b.classList.toggle('active', locked ? v === 0 : v === pmode);
    });
  }

  // SMOOTH can't honor post-chain AA without degrading xBR output (see
  // aaEff) - gray out FXAA/SMAA; MSAA stays live (it's pre-upscale, not a
  // mid-chain pass). Locked reads as OFF so an armed-but-dead pick
  // doesn't display as active.
  function syncAALocks(): void {
    const locked = pmodeEff() === 1;
    const row = document.getElementById('aa-row');
    row?.querySelectorAll('button').forEach((b): void => {
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

  // persist=false for staging holds (boot veil): the stored key is the
  // user's pick - a temporary off must not overwrite it.
  function setPostProcessingEnabled(enabled: boolean, persist = true): void {
    // Floyd mode has no composer - enabling post there drops floyd rather
    // than silently refusing (the toggle used to clamp back to OFF with
    // no feedback and read as dead). Other pixel modes share the chain.
    if (enabled && pmodeEff() === 3) {setPixel(pscale, 0, false);} // compat drop, not a user pick
    postproEnabled = enabled;
    if (persist) {settings.set('fps-postpro', postproEnabled);}
    gradePass.enabled = postproEnabled;
    syncRenderToScreen();
    postproToggleBtn.classList.toggle('on', postproEnabled);
  }

  function setBloomEnabled(enabled: boolean): void {
    // Same story as post - only atkinson is exclusive.
    if (enabled && pmodeEff() === 3) {setPixel(pscale, 0, false);}
    bloomEnabled = enabled;
    settings.set('fps-bloom', bloomEnabled);
    bloomMergePass.enabled = bloomEnabled;
    dirtEffect.uniforms.get('dirtIntensity')!.value = enabled && !modes.dirtOff ? 3 : 0;
    syncRenderToScreen();
    bloomToggleBtn.classList.toggle('on', bloomEnabled);
  }

  function resize(_width: number, _height: number): void {
    applyBufferSizes();
  }

  // Setup window resize handler
  window.addEventListener('resize', (): void => { camera.aspect = GAME_ASPECT; camera.updateProjectionMatrix(); applyBufferSizes(); });

  const { bloomToggleBtn, postproToggleBtn } = wireToggleButtons(modes,
    (): void => setBloomEnabled(!bloomEnabled),
    (): void => setPostProcessingEnabled(!postproEnabled));

  // applyBufferSizes (not just updateRendererSize): pixel/composer
  // pass enables are only re-evaluated on that path.
  // 0.5X (2× supersample - fill-rate profiling) is a dev-box control:
  // localhost exposes the button, tunneled/prod users never see it.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]') {
    document.getElementById('pscale-half')?.style.removeProperty('display');
  }
  markPscale = wireSegRow('pscale-row', (): number => pscale,
    (v): void => setPixel(v, pmode));
  markPmode = wireSegRow('pmode-row', (): number => pmode,
    (v): void => setPixel(pscale, v));
  syncPmodeLocks(); // boot: 1× scale starts with non-RAW locked
  // applyAA wrapper takes the picked v (wireAARow calls it before onChange
  // updates our aaMode) - clamps to 0 whenever a non-RAW mode is live.
  wireAARow((v): void => applyAA(pmodeEff() === 1 && (v === 1 || v === 2) ? 0 : v), (v): void => { aaMode = v; });
  syncAALocks(); // boot: non-RAW pixel mode starts with AA locked

  // COLORS row: palette-level presets, persisted like the AA pick.
  const RETRO_PRESETS = [0, 256, 64, 16, 8];
  let retroPick = settings.get('fps-retro');
  applyRetro(RETRO_PRESETS[retroPick] ?? 0);
  wireSegRow('retro-row', (): number => retroPick,
    (v): void => {
      retroPick = v; settings.set('fps-retro', v);
      applyRetro(RETRO_PRESETS[v] ?? 0);
    });

  // Postpro is the master switch for the composer chain: the grade pass
  // IS the output transform - a live composer minus grade pumps raw
  // linear HDR to canvas (overexposed). So OFF must mean direct render:
  // bloom/AA keep their (unpersisted) picks but can't drive the composer
  // without it, and materials' own tone mapping takes over on canvas.
  // Residual: SMOOTH/xBR upscale + postpro-off still lacks a terminal
  // encode - a debug-tier combo, not a user tier.
  const needsComposerNow = (): boolean => postproEnabled || retroPick > 0 ||
    (pscale > 1 && (pmode === 1 || pmode === 2)) ||
    (resScale < 1 && pscale === 1 && settings.get('fps-filter') === 2);

  // Alt+Q render census - the pipeline state that produced the frame:
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

  let compileInflight = false; // warmup's reentry guard - see below
  return {
    renderer,
    composer,
    bloomPass: bloomMergePass,
    gradePass,
    render,
    needsComposer: needsComposerNow,
    setOverlayPass: (fn): void => { fsOverlay = fn; },
    isFloyd: (): boolean => pmodeEff() === 3,
    isPostProcessingEnabled: (): boolean => postproEnabled,
    isBloomEnabled: (): boolean => bloomEnabled,
    setBloomEnabled,
    applyRetro,
    updateRendererSize,
    // compileAsync reentry guard - see warmup below.
    // checkMaterialsReady throws inside three when a material added
    // mid-compile never receives a currentProgram - benign, but the
    // rejection was surfacing as a pageerror in probes.
    // Serialize: three's KHR_parallel_shader_compile poll shares one
    // internal set across calls - a second compileAsync while one is in
    // flight iterates entries the first already evicted
    // (Fe.get(e).currentProgram === undefined → isReady crash).
    warmup: (): void => {
      if (compileInflight) {return;}
      compileInflight = true;
      try {
        // Sync compile - compileAsync's KHR poll throws uncatchably in its
        // own setTimeout when a material lands mid-compile (Fe.get(e) →
        // undefined → 'isReady' crash). One serial pass has no async gap.
        renderer.compile(scene, camera);
      } finally {compileInflight = false;}
    },
    setPixel,
    setResScale,
    setPostProcessingEnabled,
    resize,
  };
}
