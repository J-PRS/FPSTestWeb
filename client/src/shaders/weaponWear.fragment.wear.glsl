// Injected after `#include <color_fragment>` — the whole procedural
// surface pass: grunge mottle, baked barycentric edge-wear lines, AO
// exposure gate, concave grime, and the WEARVIZ mask debug.
{
  // Large-scale mottled variation — reads as paint/finish, not speckle.
  float g = wfbm(vWpos * 35.0);
  diffuseColor.rgb *= 0.92 + 0.14 * g;

  // Edge wear: the DOMINANT term is the baked barycentric line — each
  // corner's weight → 0 only at triangle edges flagged sharp (>~50°
  // dihedral) at bake time, and smoothstep on the screen-space width
  // draws a ~2px line that hugs the real edge on ANY topology. The old
  // fwidth(vNormal) fallback is GONE: it measured screen-space normal
  // sweep, so smooth-shaded surfaces (tube walls, octagonal slabs) lit
  // up wherever normals interpolated fast — phantom wear on flat faces.
  vec3 ew = vBary + (1.0 - vAedge) * 4.0;
  // World-space width: ew × per-tri altitude = true object-space
  // distance to the edge, so wear is a PHYSICAL feature that scales with
  // zoom (the old fwidth-normalized line was constant screen pixels at
  // any distance). The 1.5px fwidth floor keeps far edges anti-aliased
  // instead of shimmering out.
  vec3 wd = ew * vAlt;
  vec3 edge3 = smoothstep(vec3(0.0), max(vec3(0.012), fwidth(wd) * 1.5), wd);
  float eline = 1.0 - min(edge3.x, min(edge3.y, edge3.z));
  // vWear stays as a weak vertex-level accent only — hot corner verts
  // read as chipped paint, but the 0.6 floor keeps smooth-normal
  // divergence on curved walls (≈0.5 baked) from painting whole faces.
  float edge = max(eline, smoothstep(0.6, 0.95, vWear) * 0.4);

  // Patchy mask so wear clumps in zones like real abrasion, gated to
  // well-lit (unoccluded) faces — crevices don't wear bright. The floor is
  // 0.5 (not 0.35): stacked under exposure × 0.7 mix, a low floor crushed
  // real edges below the visibility threshold — "no edge wear".
  float patches = 0.5 + 0.5 * smoothstep(0.55, 0.8, wnoise(vWpos * 90.0));
  #ifdef USE_COLOR
    // AO owns the mask — occluded crevices get NO bright wear. The band
    // is anchored at the bake's MIN_LIGHT floor (0.25): a fixed 0.45
    // cutoff was above most of this weapon's actual AO, so exposure
    // went ~0 everywhere and nothing wore.
    float exposure = smoothstep(0.28, 0.75, vColor.g);
  #else
    // Baked-GLB path: AO lives in the texture, no vertex colors — edge
    // wear stays unmasked by exposure (concave hits are rare here).
    float exposure = 1.0;
  #endif
    // awear: per-weapon boost attr (unbaked/absent → 0 → ×1 unchanged).
    float wear = min(1.0, edge * patches * exposure * (1.0 + vAw));

    // Worn metal: desaturate and brighten edges; slight micro-scratch noise.
    float scratch = wnoise(vWpos * 700.0) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.86, 0.84), wear * 0.95);
    diffuseColor.rgb *= 1.0 - wear * scratch;

    // Concave grime — the signed-curvature complement of edge wear:
    // baked per-vertex on valley edges, darkened + dirtied with the same
    // patchy clumping so seams read as collected crud, not a uniform
    // shade ramp.
    float dirt = vGrime * (0.6 + 0.4 * wnoise(vWpos * 110.0 + 31.7));
    diffuseColor.rgb *= 1.0 - dirt * 0.38;
  #ifdef WEARVIZ
    // R=final wear, G=baked AO (the exposure gate input), B=edge flag.
    // AO replaced grime here — when wear reads wrong, the AO values are
    // almost always the thing that needs eyeballing.
    #ifdef USE_COLOR
      diffuseColor.rgb = vec3(wear, vColor.g, edge);
    #else
      diffuseColor.rgb = vec3(wear, 0.0, edge);
    #endif
  #endif

  #ifdef USE_COLOR
    // Extra cavity depth beyond vertex AO — cheap contrast ramp on the bake.
    diffuseColor.rgb *= 0.6 + 0.4 * smoothstep(0.2, 0.75, vColor.g);
  #endif
}
