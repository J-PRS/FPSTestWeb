import { TONE_MAPPING_EXPOSURE } from './config.js';

// Authored colors in our custom ShaderMaterials are DISPLAY-referred —
// written to look correct when gl_FragColor goes straight to canvas.
// The composer instead grades a linear HDR buffer with ACES + sRGB
// encode, so those raw values get lifted mid-tone ("washed out"), and
// adding tonemapping_fragment/colorspace_fragment naively does the same
// lift on the CANVAS path.
//
// ungradeColor() inverts the whole output transform — sRGB decode, then
// the exact ACESFilmic fit inverse (Hill matrices + rrtOdtFit quadratic)
// + exposure — so `ungradeColor(c)` followed by the two output chunks
// reproduces c bit-for-bit on BOTH paths. Values with a channel >1 are
// HDR emitters (sun disc) — they pass through untouched so the linear
// buffer keeps >1 luminance for bloom to threshold.
export const UNGRADE_GLSL = /* glsl */ `
vec3 ungradeColor(vec3 disp) {
  if (max(disp.r, max(disp.g, disp.b)) > 1.0) return disp;
  vec3 u = sRGBTransferEOTF(vec4(disp, 1.0)).rgb;
  const mat3 ACESOutputInv = mat3(
    vec3(0.643038, 0.059269, 0.005962),
    vec3(0.311187, 0.931436, 0.063929),
    vec3(0.045775, 0.009295, 0.930118));
  const mat3 ACESInputInv = mat3(
    vec3(1.764741, -0.147028, -0.036337),
    vec3(-0.675778, 1.160252, -0.162436),
    vec3(-0.088963, -0.013224, 1.198773));
  vec3 y = ACESOutputInv * u;
  // invert rrtOdtFit per channel: y(dx^2+ex+f) = x^2+ax-c -> quadratic
  vec3 A = 0.983729 * y - 1.0;
  vec3 B = 0.432951 * y - 0.0245786;
  vec3 C = 0.238081 * y + 0.000090537;
  vec3 x = (-B - sqrt(max(B * B - 4.0 * A * C, vec3(0.0)))) / (2.0 * A);
  return max(ACESInputInv * x, vec3(0.0)) / (${TONE_MAPPING_EXPOSURE.toFixed(4)} / 0.6);
}

// Terrain bloom guard — runs AFTER ungradeColor, in the same HDR-linear
// space bloom thresholds. Bloom's 1.3 gate has a 0.25 soft knee, so
// linear luminance from ~1.05 up already blooms partially. Terrain is NOT
// an emitter (bloom is for explosions, projectiles and trails) — hard
// clamp its luminance to 0.95 so it sits safely below the soft-knee start
// and contributes zero bloom. Real emitters (sun disc, trails, VFX) write
// their own >1 color and never pass through this call.
vec3 bloomGuard(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l > 0.95) return c * (0.95 / l);
  return c;
}
`;
