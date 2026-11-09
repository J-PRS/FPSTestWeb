// GLSL blobs for the post/pixel pipeline — pure data kept out of
// renderer.ts so the setup file stays navigable. These are
// postprocessing `Effect` fragment bodies (mainImage signature).
import { TONE_MAPPING_EXPOSURE } from './config.js';

export const UPSCALE_GLSL = /* glsl */ `
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
export const XBR_GLSL = /* glsl */ `
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
      // inputBuffer is LINEAR-filtered — upstream samples a nearest source,
      // so every tap snaps to the texel center under the output fragment or
      // the eq/neq edge rules compare bilinear blur instead of source art.
      vec2 base = (floor(uv / inv) + 0.5) * inv;
      vec4 A1v = texture2D(inputBuffer, base + vec2(-dx, -2.0*dy));
      vec4 B1v = texture2D(inputBuffer, base + vec2(0.0, -2.0*dy));
      vec4 C1v = texture2D(inputBuffer, base + vec2(dx, -2.0*dy));
      vec4 Av  = texture2D(inputBuffer, base + vec2(-dx, -dy));
      vec4 Bv  = texture2D(inputBuffer, base + vec2(0.0, -dy));
      vec4 Cv  = texture2D(inputBuffer, base + vec2(dx, -dy));
      vec4 Dv  = texture2D(inputBuffer, base + vec2(-dx, 0.0));
      vec4 Ev  = texture2D(inputBuffer, base);
      vec4 Fv  = texture2D(inputBuffer, base + vec2(dx, 0.0));
      vec4 Gv  = texture2D(inputBuffer, base + vec2(-dx, dy));
      vec4 Hv  = texture2D(inputBuffer, base + vec2(0.0, dy));
      vec4 Iv  = texture2D(inputBuffer, base + vec2(dx, dy));
      vec4 G5v = texture2D(inputBuffer, base + vec2(-dx, 2.0*dy));
      vec4 H5v = texture2D(inputBuffer, base + vec2(0.0, 2.0*dy));
      vec4 I5v = texture2D(inputBuffer, base + vec2(dx, 2.0*dy));
      vec4 A0v = texture2D(inputBuffer, base + vec2(-2.0*dx, -dy));
      vec4 D0v = texture2D(inputBuffer, base + vec2(-2.0*dx, 0.0));
      vec4 G0v = texture2D(inputBuffer, base + vec2(-2.0*dx, dy));
      vec4 C4v = texture2D(inputBuffer, base + vec2(2.0*dx, -dy));
      vec4 F4v = texture2D(inputBuffer, base + vec2(2.0*dx, 0.0));
      vec4 I4v = texture2D(inputBuffer, base + vec2(2.0*dx, dy));
      // Luma on a 0-255 scale — the threshold constants assume byte range.
      vec3 A1=A1v.rgb*255.0,B1=B1v.rgb*255.0,C1=C1v.rgb*255.0;
      vec3 A=Av.rgb*255.0,B=Bv.rgb*255.0,C=Cv.rgb*255.0;
      vec3 D=Dv.rgb*255.0,E=Ev.rgb*255.0,F=Fv.rgb*255.0;
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
      // Upstream: only fx45i carries the -Ci (0.25) bias — fx45 without it
      // was the dead rule that left the output ≈nearest.
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
export const ACES_GLSL = /* glsl */ `
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

// Vibrance (CeeJay.dk / SweetFX formulation) — Photoshop-style: the boost
// scales by (1 - saturation), so muted colors get pushed and already-hot
// pixels (muzzle flashes, sky) barely move. Uniform saturation can't do
// that — it neon-signs everything equally.
export const VIBRANCE_GLSL = /* glsl */ `
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec3 c = inputColor.rgb;
      vec3 lum = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float sat = mx - mn;
      float k = 1.0 + 0.06 * (1.0 - sat);
      outputColor = vec4(mix(lum, c, k), inputColor.a);
    }
  `;

// Permanent subtle vignette — ~0 cost inside the fused grade pass.
// Edge-dim + light desat reads as "lens" and keeps the eye on the
// reticle; deliberately weaker than #dmg-vignette's damage feedback
// band so it never reads as a hit tell.
export const VIGNETTE_GLSL = /* glsl */ `
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      float d = distance(uv, vec2(0.5));
      // gentle 12% dim at corners, desaturating slightly with it
      float k = smoothstep(0.42, 0.82, d);
      vec3 c = inputColor.rgb * (1.0 - 0.12 * k);
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, vec3(lum), 0.15 * k);
      outputColor = vec4(c, inputColor.a);
    }
  `;

// CAS sharpen — REMOVED after two regressions (dark frame from a bad
// texel fetch, then global lift). The idea is sound but unverifiable
// blind; revisit against a reference implementation with a live A/B.
// HDR sanitize — runs between RenderPass and the bloom/dirt chain.
// The composer buffers are HalfFloat: an additive stack (EMIT_GAIN ×
// overlapping trails/explosions, the sun disc) can push a texel past
// 65504 → Inf. Bloom's mip chain then lerps Inf-Inf → NaN, and the
// upsample smears one bad texel across the whole frame — the "glow on =
// screen flickers black" bug. Zero non-finite channels and clamp to a
// sane HDR ceiling; 64 is far past the 1.3 bloom threshold, so hot
// emitters still halo at full strength.
export const SANITIZE_GLSL = /* glsl */ `
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec3 c = inputColor.rgb;
      // NaN fails EVERY comparison (IEEE): the >= 0.0 guard drops NaN to
      // black, Inf survives the guard and clamps to the ceiling, negatives
      // floor at 0. Portable — no isnan()/isinf() (GLSL ES 3.00 only).
      c.r = c.r >= 0.0 ? min(c.r, 64.0) : 0.0;
      c.g = c.g >= 0.0 ? min(c.g, 64.0) : 0.0;
      c.b = c.b >= 0.0 ? min(c.b, 64.0) : 0.0;
      float a = inputColor.a >= 0.0 ? min(inputColor.a, 1.0) : 0.0;
      outputColor = vec4(c, a);
    }
  `;

// Bloom merge shader — postprocessing's stock version is one line:
// `outputColor = texture2D(map, uv) * intensity`, SCREEN-blended over the
// frame. A NaN anywhere in the mipmap-blur texture (Inf-Inf inside a blur
// tap, a stale mip level, driver UB on garbage input) therefore writes a
// NaN pixel — pure black, often a huge diamond where one bad deep-mip
// texel upsamples. Guard the SAMPLE, not the frame: fold non-finite
// channels to 0 so the region just loses its halo instead of going black.
// This is identical to bloom_default otherwise.
export const BLOOM_MERGE_GLSL = /* glsl */ `
    #ifdef FRAMEBUFFER_PRECISION_HIGH
    uniform mediump sampler2D map;
    #else
    uniform lowp sampler2D map;
    #endif
    uniform float intensity;
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec4 t = texture2D(map, uv);
      t.r = t.r >= 0.0 ? min(t.r, 64.0) : 0.0;
      t.g = t.g >= 0.0 ? min(t.g, 64.0) : 0.0;
      t.b = t.b >= 0.0 ? min(t.b, 64.0) : 0.0;
      t.a = t.a >= 0.0 ? t.a : 0.0;
      outputColor = t * intensity;
    }
  `;

// Lens dirt, Unity PPv2-style: smudge texture × the ISOLATED bloom
// buffer (the blurred mip composite), added over the frame. Unity:
//   color += bloomTex*intensity + dirtTex*bloomTex*dirtIntensity
// The bloom composite already holds only above-threshold light, so no
// gate is needed — fog luminance never enters the buffer, so dirt can
// NEVER paint the sky the way a merged-frame luminance threshold can.
export const LENS_DIRT_GLSL = `
uniform sampler2D dirtMap;
uniform sampler2D bloomTex;
uniform float dirtIntensity;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Cover-fit the dirt texture (CSS background-size:cover): scale the
  // longer axis out so smudges stay round on any aspect — Unity's
  // _Bloom_DirtTileOffset does the same, raw uv was stretching them.
  vec2 dirtUv = (uv - 0.5) * vec2(min(1.0, aspect), min(1.0, 1.0 / aspect)) + 0.5;
  vec3 dirt = texture2D(dirtMap, dirtUv).rgb;
  vec3 bloom = texture2D(bloomTex, uv).rgb;
  // bloomTex is the RAW mip composite — pre-sanitize, unclamped. Inf/NaN
  // texels that BLOOM_MERGE_GLSL folds for display live here too, and
  // Inf*dirt / NaN*0 re-poisons the frame AFTER the last guard — the
  // black half-screen flash all over again. Same IEEE fold, same 64 cap.
  bloom.r = bloom.r >= 0.0 ? min(bloom.r, 64.0) : 0.0;
  bloom.g = bloom.g >= 0.0 ? min(bloom.g, 64.0) : 0.0;
  bloom.b = bloom.b >= 0.0 ? min(bloom.b, 64.0) : 0.0;
  dirt.r = dirt.r >= 0.0 ? dirt.r : 0.0;
  dirt.g = dirt.g >= 0.0 ? dirt.g : 0.0;
  dirt.b = dirt.b >= 0.0 ? dirt.b : 0.0;
  outputColor = vec4(inputColor.rgb + dirt * bloom * dirtIntensity, inputColor.a);
}`;

/** Retro - pixelation + uniform palette quantize in one pass. pixel>0
 *  snaps UVs to a coarse grid; levels>0 snaps color to N steps/channel.
 *  Runs on the display-space frame (post-grade, post-AA). */
export const RETRO_GLSL = /* glsl */ `
uniform float levels;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 c = inputColor;
  if (levels > 0.5) {
    float n = levels - 1.0;
    c.rgb = round(c.rgb * n) / n;
  }
  outputColor = c;
}`;
