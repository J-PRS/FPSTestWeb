import * as THREE from 'three';
import { settings } from './settings.js';
import { urlParams } from './params.js';
import {
  Effect,
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  BrightnessContrastEffect,
  BlendFunction,
} from 'postprocessing';
import {
  PIXEL_SCALE,
  TONE_MAPPING_EXPOSURE,
} from './config.js';

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
  setPixelated: (mode: number) => void;
  setPostProcessingEnabled: (enabled: boolean) => void;
  resize: (width: number, height: number) => void;
}

interface RenderModes { pixelMode: number; postproEnabled: boolean; bloomEnabled: boolean }

const PX_MODES: Record<string, number> = {
  off: 0, hard: 1, medium: 2, smooth: 3, on: 3, dither: 4, dithered: 4, fs: 5, floyd: 5,
};

const PIXEL_LABELS = ['PIXELATION: OFF', 'PIXELATION: HARD', 'PIXELATION: MEDIUM',
  'PIXELATION: SMOOTH', 'PIXELATION: DITHERED', 'PIXELATION: FLOYD'];
const pixelLabel = (m: number): string => PIXEL_LABELS[m] ?? PIXEL_LABELS[0]!;

// Pixel mode: 0 = off, 1 = hard 4x4, 2 = medium 2x2, 3 = xBR-smooth
// upscale, 4 = hard + Bayer-ordered dither (composer path),
// 5 = true CPU Floyd-Steinberg on the low-res buffer
function resolveModes(): RenderModes {
  let pixelMode = settings.get('fps-pixelated');
  // All post-processing defaults OFF — the scene reads cleanest raw.
  // Opt in via localStorage or ?postpro=on / ?bloom=on.
  let postproEnabled = settings.get('fps-postpro');
  let bloomEnabled = settings.get('fps-bloom');
  // URL overrides for headless screenshots/testing
  const px = urlParams.get('pixelated');
  if (px !== null && px in PX_MODES) pixelMode = PX_MODES[px]!;
  const pp = urlParams.get('postpro');
  if (pp !== null) postproEnabled = pp === 'on';
  const bm = urlParams.get('bloom');
  if (bm !== null) bloomEnabled = bm === 'on';
  // Pixelated is the cheap path: stored bloom/postpro don't re-engage
  // under it (hard mode has no composer at all); URL params may opt in.
  if (pixelMode > 0 && pp === null && bm === null) {
    postproEnabled = false;
    bloomEnabled = false;
  }
  return { pixelMode, postproEnabled, bloomEnabled };
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
      const srcRow = (h - 1 - y) * w * 4; // GL rows are bottom-up — flip here
      const dstRow = y * w * 4;
      const cur = errA; errA = errB; errB = cur; errB.fill(0);
      // Serpentine: alternate scan direction per row — pure raster order
      // smears error one way and leaves diagonal worm artifacts
      const fwd = (y & 1) === 0;
      for (let xi = 0; xi < w; xi++) {
        const x = fwd ? xi : w - 1 - xi;
        const si = srcRow + x * 4, di = dstRow + x * 4, ei = x * 3;
        const ahead = fwd ? 3 : -3, behind = -ahead;
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
    ctx2d.putImageData(img, 0, 0);
  }

  return { canvasEl, alloc, quantize };
}

// xBR-lite upscaler for SMOOTH pixelated mode: the scene renders at
// 1/PIXEL_SCALE, then flat texel interiors sample nearest (crisp pixels)
// while detected edges get diagonal-aware blending — xBR philosophy.
const UPSCALE_GLSL = /* glsl */ `
    uniform vec2 lowTexel; // 1/low-res-buffer size
    uniform float mode;  // 0 = nearest (hard pixels), 1 = edge-aware
    // Luma-weighted distance — unweighted RGB treats a blue↔red edge the
    // same as an equal-magnitude green shift, but the eye disagrees.
    float cdist(vec3 a, vec3 b) {
      vec3 d = a - b;
      return dot(d * d, vec3(0.299, 0.587, 0.114));
    }
    // Sharpen t around its midpoint by k — 1.0 = bilinear, grows toward
    // a step as edge contrast rises. Smooth nearest-morph, no floor snap.
    float sharpen(float t, float k) {
      return smoothstep(0.0, 1.0, clamp((t - 0.5) * k + 0.5, 0.0, 1.0));
    }
    // Branchless Bayer matrices — classic bit-free formulation
    float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
    float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
    float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec2 inv = lowTexel;
      vec2 pos = uv / inv - 0.5;
      vec2 i = floor(pos);
      vec2 f = fract(pos);

      vec3 c00 = texture2D(inputBuffer, (i + vec2(0.5, 0.5)) * inv).rgb;

      if (mode < 0.5) {
        outputColor = vec4(c00, 1.0);
        return;
      }

      if (mode > 1.5) {
        // Ordered dither stand-in for Floyd–Steinberg: quantize each channel
        // to LEVELS through an 8x8 Bayer threshold keyed on the LOW-RES texel
        // index, so every chunky pixel carries one dithered shade. True error
        // diffusion needs compute shaders (WebGPU) — this is the WebGL answer.
        const float LEVELS = 8.0;
        float b = bayer8(i);
        vec3 q = floor(c00 * (LEVELS - 1.0) + b) / (LEVELS - 1.0);
        outputColor = vec4(clamp(q, 0.0, 1.0), 1.0);
        return;
      }

      vec3 c10 = texture2D(inputBuffer, (i + vec2(1.5, 0.5)) * inv).rgb;
      vec3 c01 = texture2D(inputBuffer, (i + vec2(0.5, 1.5)) * inv).rgb;
      vec3 c11 = texture2D(inputBuffer, (i + vec2(1.5, 1.5)) * inv).rgb;

      float d0 = cdist(c00, c11); // main-diagonal coherence
      float d1 = cdist(c01, c10); // anti-diagonal coherence
      float e  = max(max(cdist(c00, c10), cdist(c00, c01)),
                     max(cdist(c10, c11), cdist(c01, c11)));

      if (e < 0.002) {
        // flat — hard pixel (nearest)
        vec3 c = f.x < 0.5 ? (f.y < 0.5 ? c00 : c01) : (f.y < 0.5 ? c10 : c11);
        outputColor = vec4(c, 1.0);
      } else {
        // Diagonal or cardinal edge. Bilinear is the safe answer when the
        // diagonal coherence is weak; commit to the diagonal pair only as
        // confidence grows — kills the 2-color stair on shallow diagonals.
        vec3 bilin = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
        float conf = clamp(abs(d0 - d1) * 25.0, 0.0, 1.0);
        vec3 diag;
        if (d0 < d1) {
          float t = smoothstep(0.0, 1.0, clamp((f.x + f.y - 1.0) * 2.0 + 0.5, 0.0, 1.0));
          diag = mix(c00, c11, t);
        } else {
          float t = smoothstep(0.0, 1.0, clamp((f.y - f.x) * 2.0 + 0.5, 0.0, 1.0));
          diag = mix(c10, c01, t);
        }
        // Cardinal sharpening: pull bilinear toward nearest along whichever
        // axis has less contrast — the stronger the edge, the harder the cut.
        float ex = cdist(c00, c10) + cdist(c01, c11); // vertical edge strength
        float ey = cdist(c00, c01) + cdist(c10, c11); // horizontal edge strength
        float fx = sharpen(f.x, 1.0 + clamp((ex - ey) * 6.0, 0.0, 5.0));
        float fy = sharpen(f.y, 1.0 + clamp((ey - ex) * 6.0, 0.0, 5.0));
        vec3 card = mix(mix(c00, c10, fx), mix(c01, c11, fx), fy);
        outputColor = vec4(mix(mix(bilin, card, 0.65), diag, conf), 1.0);
      }
    }
  `;

// Tone-map pass — renders to a composer target DON'T apply tone mapping
// (three only applies ACES when rendering straight to canvas), so without
// this the whole composer path outputs a brighter, desaturated grade:
// "bloom breaks the colors". Replicates three's exact ACESFilmic curve
// (RRTAndODTFit + ACES matrices) with our 0.4 exposure baked in, so the
// composer output is pixel-identical in grading to direct rendering.
const ACES_GLSL = /* glsl */ `
    vec3 rrtOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      const mat3 ACESInput = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutput = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602));
      vec3 c = inputColor.rgb * (${TONE_MAPPING_EXPOSURE} / 0.6);
      c = ACESInput * c;
      c = rrtOdtFit(c);
      c = clamp(ACESOutput * c, 0.0, 1.0);
      outputColor = vec4(c, inputColor.a);
    }
  `;

// Low-res sizing for hard/medium/floyd modes. Returns true when the mode
// renders into a shrunken GL canvas (caller handles FS buffer alloc).
// GL canvas MUST stay visible — pointer lock targets it, and a
// display:none element can't lock; fsCanvas is pointer-events:none.
function applyPixelSize(renderer: THREE.WebGLRenderer,
    fsCanvas: HTMLCanvasElement, pixelMode: number): boolean {
  fsCanvas.style.display = pixelMode === 5 ? 'block' : 'none';
  if (pixelMode !== 1 && pixelMode !== 2 && pixelMode !== 5) return false;
  const f = pixelMode === 2 ? PIXEL_SCALE / 2 : PIXEL_SCALE;
  renderer.setPixelRatio(1);
  renderer.setSize(Math.floor(window.innerWidth / f),
    Math.floor(window.innerHeight / f), false);
  renderer.domElement.style.imageRendering = 'pixelated';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  return true;
}

// Whole-scene bloom gated by a luminance threshold: emitters (trails,
// explosions, nuggets) push the brightest colors, the lit terrain and sky
// stay under it, so bloom never washes the frame. (A second composer and
// SelectiveBloomEffect both proved fragile here — keep the simple one.)
function makeComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    camera: THREE.PerspectiveCamera, bloomEnabled: boolean,
    postproEnabled: boolean, pixelMode: number) {
  const bloomEffect = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0.9,
    intensity: 1.5,
    radius: 0.6,
  });

  const upscaleEffect = new Effect('EdgeUpscale', UPSCALE_GLSL, {
    blendFunction: BlendFunction.NORMAL,
    uniforms: new Map<string, THREE.Uniform>([
      ['lowTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
      ['mode', new THREE.Uniform(1)],
    ]),
  });

  const acesGradeEffect = new Effect('ACESGrade', ACES_GLSL);

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  composer.addPass(new RenderPass(scene, camera));

  const acesPass = new EffectPass(camera, acesGradeEffect);
  composer.addPass(acesPass);

  const bloomMergePass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomMergePass);

  const contrastPass = new EffectPass(camera, new BrightnessContrastEffect({ contrast: 0.06 }));
  composer.addPass(contrastPass);

  // acesPass re-grades the RenderPass output so the composer chain sees
  // the same post-ACES values a direct canvas render produces — bloom
  // thresholds behave identically either way.

  // Pixelated mode: scene renders at 1/PIXEL_SCALE into the composer buffer,
  // then this pass upscales to the full-res canvas with edge-aware blending.
  const upscalePass = new EffectPass(camera, upscaleEffect);
  composer.addPass(upscalePass);

  bloomMergePass.enabled = bloomEnabled;
  contrastPass.enabled = postproEnabled;
  upscalePass.enabled = pixelMode === 3 || pixelMode === 4;
  upscaleEffect.uniforms.get('mode')!.value = pixelMode === 4 ? 2 : 1;

  return { composer, bloomMergePass, contrastPass, upscalePass, upscaleEffect };
}

function wireToggleButtons(px: HTMLButtonElement, bm: HTMLButtonElement,
    pp: HTMLButtonElement, onPx: () => void, onBm: () => void, onPp: () => void): void {
  px.addEventListener('click', onPx);
  bm.addEventListener('click', onBm);
  pp.addEventListener('click', onPp);
}

export function createRenderer(camera: THREE.PerspectiveCamera, scene: THREE.Scene): RendererSetup {
  const modes = resolveModes();
  let pixelMode = modes.pixelMode;
  let postproEnabled = modes.postproEnabled;
  let bloomEnabled = modes.bloomEnabled;

  const renderer = new THREE.WebGLRenderer({ antialias: false });

  const fs = makeFloydEngine(renderer);
  const fsCanvas = fs.canvasEl;
  fsCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:none;pointer-events:none;z-index:1';
  document.body.appendChild(fsCanvas);
  let fsOverlay: (() => void) | null = null; // viewmodel pass, injected by gameLoop

  function getPixelRatio(): number {
    return pixelMode > 0 ? 1 : Math.min(window.devicePixelRatio, 2);
  }

  function updateRendererSize(): void {
    // Hard/medium never touch the composer: render straight into a low-res
    // canvas and let CSS upscale it — colors are identical to direct
    // rendering by construction, and it's the cheapest path. Floyd (5)
    // uses the same low-res GL render with fsCanvas on top.
    if (applyPixelSize(renderer, fsCanvas, pixelMode)) {
      if (pixelMode === 5) {
        fsCanvas.width = renderer.domElement.width;
        fsCanvas.height = renderer.domElement.height;
        fs.alloc(fsCanvas.width, fsCanvas.height);
      }
      return;
    }
    // Canvas stays full-res — in smooth mode only the composer buffers
    // drop to 1/PIXEL_SCALE and the upscale pass reconstructs to screen.
    renderer.setPixelRatio(getPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = 'auto';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
  }

  updateRendererSize();
  // Skip the whole shadow-map raster when the scene opted out — the
  // second full-scene pass is the dominant fill cost on weak GPUs.
  renderer.shadowMap.enabled = urlParams.get('shadows') !== 'off' && settings.get('fps-shadows');
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  document.body.appendChild(renderer.domElement);

  // Initialize button text from localStorage
  const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
  pixelToggleBtn.textContent = pixelLabel(pixelMode);

  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  bloomToggleBtn.textContent = bloomEnabled ? 'BLOOM: ON' : 'BLOOM: OFF';

  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';

  const cc = makeComposer(renderer, scene, camera, bloomEnabled, postproEnabled, pixelMode);
  const { composer, bloomMergePass, contrastPass, upscalePass, upscaleEffect } = cc;

  // composer.setSize() also resizes the canvas — so always set buffers first,
  // then restore the canvas to full res. Pixelated = low-res buffers upscaled
  // by the final pass; the canvas itself never shrinks.
  function applyBufferSizes(): void {
    // Composer buffers only shrink for smooth mode — hard/medium bypass it.
    const smallBuf = pixelMode === 3 || pixelMode === 4;
    const w = smallBuf ? Math.floor(window.innerWidth / PIXEL_SCALE) : window.innerWidth;
    const h = smallBuf ? Math.floor(window.innerHeight / PIXEL_SCALE) : window.innerHeight;
    composer.setSize(w, h);
    upscaleEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    // composer.setSize() also resizes the canvas — restore whichever canvas
    // sizing the active pixel mode wants.
    updateRendererSize();
  }
  applyBufferSizes();

  function render(dt?: number): void {
    if (pixelMode === 5) {
      renderer.render(scene, camera);
      fsOverlay?.(); // viewmodel renders onto the hidden GL canvas pre-readback
      fs.quantize();
      return;
    }
    composer.render(dt);
  }

  function setPixelated(mode: number): void {
    pixelMode = mode;
    settings.set('fps-pixelated', pixelMode);
    upscalePass.enabled = pixelMode === 3 || pixelMode === 4;
    upscaleEffect.uniforms.get('mode')!.value = pixelMode === 4 ? 2 : 1;
    // Pixelated is the cheap/retro path — bloom and contrast post-pro are
    // the opposite of "simple low-res render", so opting in drops them.
    if (pixelMode > 0) {
      if (postproEnabled) setPostProcessingEnabled(false);
      if (bloomEnabled) setBloomEnabled(false);
    }
    updateRendererSize();
    applyBufferSizes();
    pixelToggleBtn.textContent = pixelLabel(pixelMode);
  }

  function setPostProcessingEnabled(enabled: boolean): void {
    // Hard/medium pixelation have no composer — post can't exist there.
    postproEnabled = enabled && (pixelMode === 0 || pixelMode === 3);
    settings.set('fps-postpro', postproEnabled);
    contrastPass.enabled = postproEnabled;
    postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  }

  function setBloomEnabled(enabled: boolean): void {
    // Bloom needs the composer — hard/medium pixelation have none.
    bloomEnabled = enabled && (pixelMode === 0 || pixelMode === 3);
    settings.set('fps-bloom', bloomEnabled);
    bloomMergePass.enabled = bloomEnabled;
    bloomToggleBtn.textContent = bloomEnabled ? 'BLOOM: ON' : 'BLOOM: OFF';
  }

  function resize(_width: number, _height: number): void {
    applyBufferSizes();
  }

  // Setup window resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyBufferSizes();
  });

  wireToggleButtons(pixelToggleBtn, bloomToggleBtn, postproToggleBtn,
    () => setPixelated((pixelMode + 1) % 6),
    () => setBloomEnabled(!bloomEnabled),
    () => setPostProcessingEnabled(!postproEnabled));

  return {
    renderer,
    composer,
    bloomPass: bloomMergePass,
    contrastPass,
    render,
    needsComposer: () => pixelMode >= 3 || pixelMode === 5 || bloomEnabled || postproEnabled,
    setOverlayPass: (fn) => { fsOverlay = fn; },
    isFloyd: () => pixelMode === 5,
    isPostProcessingEnabled: () => postproEnabled,
    isBloomEnabled: () => bloomEnabled,
    setBloomEnabled,
    updateRendererSize,
    setPixelated,
    setPostProcessingEnabled,
    resize,
  };
}
