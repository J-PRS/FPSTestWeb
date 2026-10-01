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
  FXAAEffect,
  SMAAEffect,
} from 'postprocessing';
import {
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

interface RenderModes { pscale: number; pmode: number; postproEnabled: boolean; bloomEnabled: boolean }

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
  if (localStorage.getItem('fps-pixelated') !== null || localStorage.getItem('fps-pscale') !== null || localStorage.getItem('fps-shadows') !== null) return;
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
  if (localStorage.getItem('fps-pscale') === null) {
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
  return { pscale, pmode, postproEnabled, bloomEnabled };
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

// Hyllian's xBR-lv2 (libretro port) — real edge-rule upscaler: a 5x5
// neighborhood of luma samples feeds thresholded eq/neq rules that find
// 30°/45°/60° edges and corners, then blends along the detected line with
// sub-texel weights. Output is the vector-art smoothness the lite shader
// approximates. One fullscreen pass, 21 taps — far cheaper than the
// scene raster a 4x res drop saves.
const XBR_GLSL = /* glsl */ `
    uniform vec2 lowTexel;   // 1/low-res-buffer size
    uniform float xbrScale;  // upscale factor (dst px per src texel)
    vec4 df(vec4 A, vec4 B) { return abs(A - B); }
    vec4 diff(vec4 A, vec4 B) {
      return vec4(A.x != B.x ? 1.0 : 0.0, A.y != B.y ? 1.0 : 0.0,
                  A.z != B.z ? 1.0 : 0.0, A.w != B.w ? 1.0 : 0.0);
    }
    vec4 eq(vec4 A, vec4 B) { return step(df(A, B), vec4(15.0)); }
    vec4 neq(vec4 A, vec4 B) { return vec4(1.0) - eq(A, B); }
    vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) {
      return df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0*df(g,h);
    }
    float c_df(vec3 c1, vec3 c2) { vec3 d = abs(c1 - c2); return d.r + d.g + d.b; }
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec2 inv = lowTexel;
      float dx = inv.x, dy = inv.y;
      vec2 fp = fract(uv / inv);
      float S = xbrScale;
      vec4 delta = vec4(1.0/S), delta_l = vec4(0.5/S, 1.0/S, 0.5/S, 1.0/S);
      vec4 delta_u = delta_l.yxwz;
      vec4 A1v = texture2D(inputBuffer, uv + vec2(-dx, -2.0*dy));
      vec4 B1v = texture2D(inputBuffer, uv + vec2(0.0, -2.0*dy));
      vec4 C1v = texture2D(inputBuffer, uv + vec2(dx, -2.0*dy));
      vec4 Av  = texture2D(inputBuffer, uv + vec2(-dx, -dy));
      vec4 Bv  = texture2D(inputBuffer, uv + vec2(0.0, -dy));
      vec4 Cv  = texture2D(inputBuffer, uv + vec2(dx, -dy));
      vec4 Dv  = texture2D(inputBuffer, uv + vec2(-dx, 0.0));
      vec4 Fv  = texture2D(inputBuffer, uv + vec2(dx, 0.0));
      vec4 Gv  = texture2D(inputBuffer, uv + vec2(-dx, dy));
      vec4 Hv  = texture2D(inputBuffer, uv + vec2(0.0, dy));
      vec4 Iv  = texture2D(inputBuffer, uv + vec2(dx, dy));
      vec4 G5v = texture2D(inputBuffer, uv + vec2(-dx, 2.0*dy));
      vec4 H5v = texture2D(inputBuffer, uv + vec2(0.0, 2.0*dy));
      vec4 I5v = texture2D(inputBuffer, uv + vec2(dx, 2.0*dy));
      vec4 A0v = texture2D(inputBuffer, uv + vec2(-2.0*dx, -dy));
      vec4 D0v = texture2D(inputBuffer, uv + vec2(-2.0*dx, 0.0));
      vec4 G0v = texture2D(inputBuffer, uv + vec2(-2.0*dx, dy));
      vec4 C4v = texture2D(inputBuffer, uv + vec2(2.0*dx, -dy));
      vec4 F4v = texture2D(inputBuffer, uv + vec2(2.0*dx, 0.0));
      vec4 I4v = texture2D(inputBuffer, uv + vec2(2.0*dx, dy));
      // Luma on a 0-255 scale — the threshold constants assume byte range.
      vec3 A1=A1v.rgb*255.0,B1=B1v.rgb*255.0,C1=C1v.rgb*255.0;
      vec3 A=Av.rgb*255.0,B=Bv.rgb*255.0,C=Cv.rgb*255.0;
      vec3 D=Dv.rgb*255.0,E=inputColor.rgb*255.0,F=Fv.rgb*255.0;
      vec3 G=Gv.rgb*255.0,H=Hv.rgb*255.0,I=Iv.rgb*255.0;
      vec3 G5=G5v.rgb*255.0,H5=H5v.rgb*255.0,I5=I5v.rgb*255.0;
      vec3 A0=A0v.rgb*255.0,D0=D0v.rgb*255.0,G0=G0v.rgb*255.0;
      vec3 C4=C4v.rgb*255.0,F4=F4v.rgb*255.0,I4=I4v.rgb*255.0;
      const vec3 rgbw = vec3(14.352, 28.176, 5.472);
      vec4 b = vec4(dot(B,rgbw), dot(D,rgbw), dot(H,rgbw), dot(F,rgbw));
      vec4 c = vec4(dot(C,rgbw), dot(A,rgbw), dot(G,rgbw), dot(I,rgbw));
      vec4 d = b.yzwx;
      vec4 e = vec4(dot(E,rgbw));
      vec4 f = b.wxyz;
      vec4 g = c.zwxy;
      vec4 h = b.zwxy;
      vec4 i = c.wxyz;
      vec4 i4 = vec4(dot(I4,rgbw), dot(C1,rgbw), dot(A0,rgbw), dot(G5,rgbw));
      vec4 i5 = vec4(dot(I5,rgbw), dot(C4,rgbw), dot(A1,rgbw), dot(G0,rgbw));
      vec4 h5 = vec4(dot(H5,rgbw), dot(F4,rgbw), dot(B1,rgbw), dot(D0,rgbw));
      vec4 f4 = h5.yzwx;
      vec4 fx = vec4(1.0,-1.0,-1.0,1.0)*fp.y + vec4(1.0,1.0,-1.0,-1.0)*fp.x;
      vec4 fx_l = vec4(1.0,-1.0,-1.0,1.0)*fp.y + vec4(0.5,2.0,-0.5,-2.0)*fp.x;
      vec4 fx_u = vec4(1.0,-1.0,-1.0,1.0)*fp.y + vec4(2.0,0.5,-2.0,-0.5)*fp.x;
      vec4 irlv1, irlv0 = diff(e,f) * diff(e,h);
      irlv1 = irlv0;
      // CORNER_C + SMOOTH_TIPS (the libretro defaults for blend mode).
      irlv1 = irlv0 * (neq(f,b) * neq(f,c) + neq(h,d) * neq(h,g) +
        eq(e,i) * (neq(f,f4) * neq(f,i4) + neq(h,h5) * neq(h,i5)) +
        eq(e,g) + eq(e,c));
      vec4 irlv2l = diff(e,g) * diff(d,g);
      vec4 irlv2u = diff(e,c) * diff(b,c);
      vec4 fx45i = clamp((fx + delta - vec4(1.5,0.5,-0.5,0.5) - vec4(0.25)) / (2.0*delta), 0.0, 1.0);
      vec4 fx45 = clamp((fx + delta - vec4(1.5,0.5,-0.5,0.5)) / (2.0*delta), 0.0, 1.0);
      vec4 fx30 = clamp((fx_l + delta_l - vec4(1.0,1.0,-0.5,0.0)) / (2.0*delta_l), 0.0, 1.0);
      vec4 fx60 = clamp((fx_u + delta_u - vec4(2.0,0.0,-1.0,0.5)) / (2.0*delta_u), 0.0, 1.0);
      vec4 wd1 = wd(e,c,g,i,h5,f4,h,f);
      vec4 wd2 = wd(h,d,i5,f,i4,b,e,i);
      vec4 edri = step(wd1, wd2) * irlv0;
      vec4 edr = step(wd1 + vec4(0.1), wd2) * step(vec4(0.5), irlv1);
      vec4 edr_l = step(2.0*df(f,g), df(h,c)) * irlv2l * edr;
      vec4 edr_u = step(2.0*df(h,c), df(f,g)) * irlv2u * edr;
      fx45 *= edr; fx30 *= edr_l; fx60 *= edr_u; fx45i *= edri;
      vec4 px = step(df(e,f), df(e,h));
      vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));
      vec3 res1 = E;
      res1 = mix(res1, mix(H, F, px.x), maximos.x);
      res1 = mix(res1, mix(B, D, px.z), maximos.z);
      vec3 res2 = E;
      res2 = mix(res2, mix(F, B, px.y), maximos.y);
      res2 = mix(res2, mix(D, H, px.w), maximos.w);
      vec3 res = mix(res1, res2, step(c_df(E,res1), c_df(E,res2)));
      outputColor = vec4(res / 255.0, inputColor.a);
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

// Low-res sizing for the CSS-upscaled paths: RAW (nearest upscale by
// definition — that's the retro look) and ATKINSON (hidden GL feed for
// the CPU dither canvas). Composer modes (smooth/dithered) keep a
// full-res canvas and shrink buffers instead. Returns true when the
// canvas was shrunk. GL canvas MUST stay visible — pointer lock targets
// it; fsCanvas is pointer-events:none.
function applyPixelSize(renderer: THREE.WebGLRenderer,
    fsCanvas: HTMLCanvasElement, pscale: number, pmode: number): boolean {
  fsCanvas.style.display = pmode === 3 ? 'block' : 'none';
  if (pscale <= 1 || (pmode !== 0 && pmode !== 3)) return false;
  renderer.setPixelRatio(1);
  renderer.setSize(Math.floor(window.innerWidth / pscale),
    Math.floor(window.innerHeight / pscale), false);
  renderer.domElement.style.imageRendering = 'pixelated';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  return true;
}

// Whole-scene bloom gated by a luminance threshold: emitters (trails,
// explosions, nuggets) push the brightest colors, the lit terrain and sky
// stay under it, so bloom never washes the frame. (A second composer and
// SelectiveBloomEffect both proved fragile here — keep the simple one.)
// Lens dirt (Unity's Bloom Dirtiness): a screen-fit smudge/dust texture
// multiplied by the POST-bloom luminance — the merged frame already
// carries the halo, so excess-over-threshold re-boosts exactly where
// glow exists. Clean frames multiply to ~0: dirt never shades the scene.
const LENS_DIRT_GLSL = `
uniform sampler2D dirtMap;
uniform float dirtIntensity;
uniform float dirtThreshold;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 dirt = texture2D(dirtMap, uv).rgb;
  float excess = max(0.0, luminance(inputColor.rgb) - dirtThreshold);
  outputColor = vec4(inputColor.rgb + dirt * excess * dirtIntensity, inputColor.a);
}`;

function makeComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    camera: THREE.PerspectiveCamera, bloomEnabled: boolean,
    postproEnabled: boolean, pmode: number) {
  const bloomEffect = new BloomEffect({
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
  composer.addPass(new RenderPass(scene, camera));

  // Bloom reads the raw linear frame, before the ACES grade clamps it to
  // display range — HDR luminance is what makes the threshold selective.
  const bloomMergePass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomMergePass);

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
  dirtPass.enabled = bloomEnabled;
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

  return { composer, bloomMergePass, dirtPass, contrastPass, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA };
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
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Fractional degrade upscales a sub-res buffer through the same CSS
    // filter path — SHARP keeps deep rungs readable, SMOOTH hides mild ones.
    renderer.domElement.style.imageRendering =
      resScale() < 1 && settings.get('fps-filter') === 0 ? 'pixelated' : 'auto';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
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
function wireAARow(applyAA: (v: number) => void): void {
  let aaMode = settings.get('fps-aa');
  applyAA(aaMode);
  wireSegRow('aa-row', () => aaMode,
    (v) => { aaMode = v; settings.set('fps-aa', v); applyAA(v); });
}

// ESC-menu toggles: seed the toggle labels from resolved modes and
// return the buttons wired to the caller's callbacks.
function wireToggleButtons(modes: RenderModes, onBm: () => void, onPp: () => void) {
  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  // Player-facing label is GLOW — "bloom" carries washed-out baggage and
  // ours is emitter-gated (trails/explosions), which is what glow means.
  bloomToggleBtn.textContent = modes.bloomEnabled ? 'GLOW: ON' : 'GLOW: OFF';
  postproToggleBtn.textContent = modes.postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  bloomToggleBtn.addEventListener('click', onBm);
  postproToggleBtn.addEventListener('click', onPp);
  return { bloomToggleBtn, postproToggleBtn };
}

// Frame render: composer for everything except ATKINSON, which draws the
// scene onto the hidden low-res canvas and CPU-quantizes onto fsCanvas.
interface RenderCtx { pmode: () => number;
  fsOverlay: () => (() => void) | null; shadowTick: () => void }
function makeRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    camera: THREE.PerspectiveCamera, composer: EffectComposer,
    fs: ReturnType<typeof makeFloydEngine>, ctx: RenderCtx): (dt?: number) => void {
  const { pmode, fsOverlay, shadowTick } = ctx;
  return (dt?: number) => {
    shadowTick();
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

  // high-performance asks the browser to pick the dGPU on dual-GPU
  // machines — default lets the OS park us on the iGPU.
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });

  const fs = makeFloydEngine(renderer);
  const fsCanvas = fs.canvasEl;
  fsCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:none;pointer-events:none;z-index:1';
  document.body.appendChild(fsCanvas);
  let fsOverlay: (() => void) | null = null; // viewmodel pass, injected by gameLoop
  // auto-quality degrade — hard-pixel modes force 1 (integer grid).
  // ?res=0.5 pins a starting scale for headless degrade/filter testing.
  const resParam = urlParams.get('res');
  let resScale = resParam !== null ? Math.min(1, Math.max(0.25, parseFloat(resParam) || 1)) : 1;
  function getPixelRatio(): number {
    return pscale > 1 ? 1 : Math.min(window.devicePixelRatio, 2) * resScale;
  }

  const updateRendererSize = makeUpdateRendererSize(renderer, fsCanvas, fs,
    { pscale: () => pscale, pmode: () => pmode, resScale: () => resScale,
      pixelRatio: getPixelRatio });

  updateRendererSize();
  // Skip the whole shadow-map raster when the scene opted out — the
  // second full-scene pass is the dominant fill cost on weak GPUs.
  renderer.shadowMap.enabled = urlParams.get('shadows') !== 'off' && settings.get('fps-shadows');
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  document.body.appendChild(renderer.domElement);

  const cc = makeComposer(renderer, scene, camera, bloomEnabled, postproEnabled, pmode);
  const { composer, bloomMergePass, dirtPass, contrastPass, upscalePass, upscaleEffect, xbrPass, xbrEffect, syncRenderToScreen, applyAA } = cc;

  // composer.setSize() also resizes the canvas — set buffers first, then
  // restore whichever canvas sizing the pixel mode wants (it never shrinks).
  function applyBufferSizes(): void {
    // Post buffers track render res: composer pixel modes render at
    // 1/pscale; the plain path uses the fractional resScale.
    const div = pscale > 1 ? pscale : 1 / resScale;
    const w = Math.floor(window.innerWidth / div);
    const h = Math.floor(window.innerHeight / div);
    composer.setSize(w, h);
    upscaleEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    xbrEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    xbrEffect.uniforms.get('xbrScale')!.value = window.innerWidth / w;
    // xBR pass handles SMOOTH pixel mode (integer degrade) and the
    // FILTER:XBR fractional tier — either case feeds it a low-res buffer.
    upscalePass.enabled = pscale > 1 && pmode === 2;
    xbrPass.enabled = (pscale > 1 && pmode === 1) ||
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
    { pmode: () => pmode, fsOverlay: () => fsOverlay,
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
    if (pmode === 3) {
      if (postproEnabled) setPostProcessingEnabled(false);
      if (bloomEnabled) setBloomEnabled(false);
    }
    updateRendererSize();
    applyBufferSizes();
    markPscale?.(pscale);
    markPmode?.(pmode);
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
    if (enabled && pmode === 3) setPixel(pscale, 0, false); // compat drop, not a user pick
    postproEnabled = enabled;
    settings.set('fps-postpro', postproEnabled);
    contrastPass.enabled = postproEnabled;
    syncRenderToScreen();
    postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  }

  function setBloomEnabled(enabled: boolean): void {
    // Same story as post — only atkinson is exclusive.
    if (enabled && pmode === 3) setPixel(pscale, 0, false);
    bloomEnabled = enabled;
    settings.set('fps-bloom', bloomEnabled);
    bloomMergePass.enabled = bloomEnabled;
    dirtPass.enabled = bloomEnabled;
    syncRenderToScreen();
    bloomToggleBtn.textContent = bloomEnabled ? 'GLOW: ON' : 'GLOW: OFF';
  }

  function resize(_width: number, _height: number): void {
    applyBufferSizes();
  }

  // Setup window resize handler
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); applyBufferSizes(); });

  const { bloomToggleBtn, postproToggleBtn } = wireToggleButtons(modes,
    () => setBloomEnabled(!bloomEnabled),
    () => setPostProcessingEnabled(!postproEnabled));

  // applyBufferSizes (not just updateRendererSize): pixel/composer
  // pass enables are only re-evaluated on that path.
  markPscale = wireSegRow('pscale-row', () => pscale,
    (v) => setPixel(v, pmode));
  markPmode = wireSegRow('pmode-row', () => pmode,
    (v) => setPixel(pscale, v));
  wireAARow(applyAA);

  return {
    renderer,
    composer,
    bloomPass: bloomMergePass,
    contrastPass,
    render,
    needsComposer: () => (pscale > 1 && (pmode === 1 || pmode === 2)) || bloomEnabled || postproEnabled ||
      (resScale < 1 && pscale === 1 && settings.get('fps-filter') === 2),
    setOverlayPass: (fn) => { fsOverlay = fn; },
    isFloyd: () => pmode === 3,
    isPostProcessingEnabled: () => postproEnabled,
    isBloomEnabled: () => bloomEnabled,
    setBloomEnabled,
    updateRendererSize,
    warmup: () => { void renderer.compileAsync(scene, camera); },
    setPixel,
    setResScale,
    setPostProcessingEnabled,
    resize,
  };
}
