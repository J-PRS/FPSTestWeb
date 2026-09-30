import io
p = 'src/core/renderer.ts'
s = io.open(p, encoding='utf-8').read()

# --- extract GLSL literals first (before other edits) ---
i = s.index("new Effect('EdgeUpscale', ")
start = s.index('`', i)
end = s.index('`', start + 1) + 1
upscale_glsl = s[start:end]
s = s[:start] + 'UPSCALE_GLSL' + s[end:]

i = s.index("new Effect('ACESGrade', ")
start = s.index('`', i)
end = s.index('`', start + 1) + 1
aces_glsl = s[start:end]
s = s[:start] + 'ACES_GLSL' + s[end:]

hdr = """interface RenderModes { pixelMode: number; postproEnabled: boolean; bloomEnabled: boolean }

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
  if (px === 'off') pixelMode = 0;
  if (px === 'hard') pixelMode = 1;
  if (px === 'medium') pixelMode = 2;
  if (px === 'smooth' || px === 'on') pixelMode = 3;
  if (px === 'dither' || px === 'dithered') pixelMode = 4;
  if (px === 'fs' || px === 'floyd') pixelMode = 5;
  const pp = urlParams.get('postpro');
  if (pp === 'off') postproEnabled = false;
  if (pp === 'on') postproEnabled = true;
  const bm = urlParams.get('bloom');
  if (bm === 'off') bloomEnabled = false;
  if (bm === 'on') bloomEnabled = true;
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
const UPSCALE_GLSL = /* glsl */ """ + upscale_glsl + """;

// Tone-map pass — renders to a composer target DON'T apply tone mapping
// (three only applies ACES when rendering straight to canvas), so without
// this the whole composer path outputs a brighter, desaturated grade:
// "bloom breaks the colors". Replicates three's exact ACESFilmic curve
// (RRTAndODTFit + ACES matrices) with our 0.4 exposure baked in, so the
// composer output is pixel-identical in grading to direct rendering.
const ACES_GLSL = /* glsl */ """ + aces_glsl + """;

"""

anchor = 'export function createRenderer'
s = s.replace(anchor, hdr + anchor, 1)

# --- replace inline mode resolution ---
old_modes = """  // Pixel mode: 0 = off, 1 = hard 4x4, 2 = medium 2x2, 3 = xBR-smooth
  // upscale, 4 = hard + Bayer-ordered dither (composer path),
  // 5 = true CPU Floyd"""
i = s.index(old_modes)
j = s.index('  const renderer = new THREE.WebGLRenderer', i)
s = s[:i] + """  const modes = resolveModes();
  let pixelMode = modes.pixelMode;
  let postproEnabled = modes.postproEnabled;
  let bloomEnabled = modes.bloomEnabled;

""" + s[j:]

# --- replace inline FS block ---
a = s.index('  // ---- Floyd')
b = s.index('  function getPixelRatio()')
s = s[:a] + """  const fs = makeFloydEngine(renderer);
  const fsCanvas = fs.canvasEl;
  fsCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:none;pointer-events:none;z-index:1';
  document.body.appendChild(fsCanvas);
  let fsOverlay: (() => void) | null = null; // viewmodel pass, injected by gameLoop

""" + s[b:]

s = s.replace('        fsAlloc(fsCanvas.width, fsCanvas.height);',
              '        fs.alloc(fsCanvas.width, fsCanvas.height);')
s = s.replace('    if (pixelMode === 5) { fsRender(); return; }',
              """    if (pixelMode === 5) {
      renderer.render(scene, camera);
      fsOverlay?.(); // viewmodel renders onto the hidden GL canvas pre-readback
      fs.quantize();
      return;
    }""")

# strip comments now duplicated at module scope
s = s.replace("""  // xBR-lite upscaler for SMOOTH pixelated mode: the scene renders at
  // 1/PIXEL_SCALE, then flat texel interiors sample nearest (crisp pixels)
  // while detected edges get diagonal-aware blending — xBR philosophy.
  const upscaleEffect""", '  const upscaleEffect')
s = s.replace("""  // Tone-map pass — renders to a composer target DON'T apply tone mapping
  // (three only applies ACES when rendering straight to canvas), so without
  // this the whole composer path outputs a brighter, desaturated grade:
  // "bloom breaks the colors". Replicates three's exact ACESFilmic curve
  // (RRTAndODTFit + ACES matrices) with our 0.4 exposure baked in, so the
  // composer output is pixel-identical in grading to direct rendering.
  const acesGradeEffect""", '  const acesGradeEffect')

io.open(p, 'w', encoding='utf-8').write(s)
print('done')
