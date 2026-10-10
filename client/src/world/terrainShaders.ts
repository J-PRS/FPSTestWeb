// Terrain GLSL — vertex displacement over the clipmap + fragment shading
// (scorch decals, fog, lighting). Kept apart from terrain.ts so the clipmap
// machinery reads without two pages of shader text.
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';

export const terrainVert = /* glsl */`
  uniform sampler2D heightMap;
  uniform float hmWorldScale;
  uniform float hScale;
  uniform vec2 gridOrigin;
  uniform float levelScale;
  uniform float gridSpacing;
  uniform float innerHalfSize;
  uniform float innerSpacing;
  uniform vec2 innerGridOrigin;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  #include <shadowmap_pars_vertex>

  float sampleHeightGPU(vec2 worldXZ) {
    vec2 uv = fract(worldXZ / hmWorldScale);
    return texture2D(heightMap, uv).r * hScale;
  }

  // Bilinear interpolation of the next-finer level's grid heights
  // The inner level's grid corner is at innerGridOrigin - innerHalfSize
  // (innerGridOrigin is the grid CENTER, not the corner)
  float sampleInnerHeight(vec2 worldXZ) {
    vec2 corner = innerGridOrigin - innerHalfSize;
    vec2 local = worldXZ - corner;
    vec2 cell = floor(local / innerSpacing);
    vec2 f = fract(local / innerSpacing);
    vec2 p00 = corner + cell * innerSpacing;
    float h00 = sampleHeightGPU(p00);
    float h10 = sampleHeightGPU(p00 + vec2(innerSpacing, 0.0));
    float h01 = sampleHeightGPU(p00 + vec2(0.0, innerSpacing));
    float h11 = sampleHeightGPU(p00 + vec2(innerSpacing, innerSpacing));
    // Single exit — ANGLE's "uninitialized f_sampleInnerHeight" warn came
    // from the early return leaving its generated return var unset.
    float h = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
    if (innerHalfSize <= 0.0) h = sampleHeightGPU(worldXZ);
    return h;
  }

  // Morph heights near the inner boundary to match the finer level,
  // using circular distance for rounder, less noticeable transitions
  float getMorphHeight(vec2 worldXZ) {
    float outerH = sampleHeightGPU(worldXZ);
    if (innerHalfSize <= 0.0) return outerH;
    vec2 d = worldXZ - innerGridOrigin;
    float dist = length(d);
    // 100% inner-height region extends BEYOND the discard boundary by 3 inner spacings.
    // This ensures all vertices of triangles spanning the discard boundary are at full inner
    // height, so the per-fragment interpolated height at the boundary exactly matches the
    // inner level. Without this, per-vertex morphing creates a height step at the seam.
    float morphStart = innerHalfSize + innerSpacing * 3.0;
    float morphEnd = innerHalfSize + innerSpacing * 9.0;
    if (dist <= morphStart) return sampleInnerHeight(worldXZ);
    if (dist >= morphEnd) return outerH;
    float blend = smoothstep(morphStart, morphEnd, dist);
    float innerH = sampleInnerHeight(worldXZ);
    return mix(innerH, outerH, blend);
  }

  void main() {
    vec2 worldXZ = gridOrigin + position.xz * levelScale;

    float eps = gridSpacing * 0.5;
    float h = getMorphHeight(worldXZ);

    // For normals, use raw GPU height if far from morph boundary (saves 4× sampleInnerHeight)
    vec2 d = worldXZ - innerGridOrigin;
    float dist = length(d);
    float morphStart = innerHalfSize + innerSpacing * 3.0;
    float morphEnd = innerHalfSize + innerSpacing * 9.0;
    bool nearBoundary = innerHalfSize > 0.0 && dist > morphStart - eps && dist < morphEnd + eps;

    float hL, hR, hD, hU;
    if (nearBoundary) {
      hL = getMorphHeight(worldXZ - vec2(eps, 0.0));
      hR = getMorphHeight(worldXZ + vec2(eps, 0.0));
      hD = getMorphHeight(worldXZ - vec2(0.0, eps));
      hU = getMorphHeight(worldXZ + vec2(0.0, eps));
    } else {
      hL = sampleHeightGPU(worldXZ - vec2(eps, 0.0));
      hR = sampleHeightGPU(worldXZ + vec2(eps, 0.0));
      hD = sampleHeightGPU(worldXZ - vec2(0.0, eps));
      hU = sampleHeightGPU(worldXZ + vec2(0.0, eps));
    }
    vNormal = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

    vec3 worldPos = vec3(worldXZ.x, h, worldXZ.y);
    vWorldPos = worldPos;
    vCameraPos = cameraPosition;

    // Shadow-receive coords — computed manually so vNormal (already
    // world-space) provides the bias offset; the mesh transform is identity.
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
        vec4 shadowWorldPosition = vec4(worldPos, 1.0) + vec4(vNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0);
        vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
      }
    #endif

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

export const terrainFrag = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  #include <common>
  #include <packing>
  uniform bool receiveShadow; // bound by the renderer (mesh.receiveShadow)
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float hscale;
  uniform int terrainPreset; // 0=mixed, 1=desert, 2=grassland
  uniform sampler2D albedoMap;
  uniform bool useAlbedo;
  // T2 material blend layer — real 256px tiles in a 4x2 atlas, blended
  // by the map's alpha weights instead of the baked albedo's flattened
  // result. Fades out with distance; the bake carries the far field.
  uniform sampler2D matTiles;
  uniform sampler2D matAlphaA;
  uniform sampler2D matAlphaB;
  uniform bool useMats;
  uniform float tileMeters;
  uniform float tileMeans[8];
  uniform float hmWorldScaleFrag;
  uniform vec3 fogColor;
  uniform float fogStart;
  uniform float fogEnd;
  uniform float innerHalfSize;
  uniform vec2 innerGridOrigin;
  uniform float edgeHalf; // outermost level only: world-edge fade radius (0=off)

  // --- hash + value noise with analytic derivatives ---
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  vec3 noised(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    vec2 du = 6.0*f*(1.0-f);
    float a = hash(i+vec2(0,0));
    float b = hash(i+vec2(1,0));
    float c = hash(i+vec2(0,1));
    float d = hash(i+vec2(1,1));
    float v = a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
    vec2  g = du * (vec2(b-a, c-a) + (a-b-c+d)*u.yx);
    return vec3(v, g);
  }
  float noise(vec2 p) { return noised(p).x; }

  // Valley mist — exponential height fog integrated along the view ray.
  // Density pools near HF_FLOOR and thins exponentially with altitude, so
  // distant lowlands dissolve into haze while ridgelines stay crisp.
  // The integral is closed-form (no marching): D0*exp(-K*(ro-FLOOR)) with
  // the (1-e^-kΔy)/(k·rd.y) term handling up/down rays exactly.
  const float HF_FLOOR = 18.0;  // world-y where fog density peaks
  const float HF_K = 0.024;     // altitude falloff (1/m) — layer thins ~every 29m
  const float HF_D0 = 0.0024;   // extinction per meter at the floor
  const float HF_CAP = 0.80;    // never fully opaque — haze, not soup
  float heightFogAmount(vec3 ro, vec3 delta, float dist) {
    if (dist < 1.0) return 0.0;
    float rdy = delta.y / dist;
    float a = HF_D0 * exp(-HF_K * max(ro.y - HF_FLOOR, 0.0));
    float od = abs(rdy) < 1e-3
      ? a * dist
      : a * (1.0 - exp(-HF_K * rdy * dist)) / (HF_K * rdy);
    return min(1.0 - exp(-max(od, 0.0)), HF_CAP);
  }

  // Exp² distance fog on the spec's linear start/end: near field stays
  // clean, haze rolls in on the natural 1-e^-(t²) curve, ~98% at fogEnd.
  float terrainFogFactor(float dist) {
    float t = clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0);
    return 1.0 - exp(-t * t * 4.0);
  }

  // --- Derivative erosion FBM (suppresses detail on steep slopes) ---
  const mat2 m2 = mat2(0.8, -0.6, 0.6, 0.8);
  float fbmErosion(vec2 p, int octaves) {
    float v=0.0, a=0.5;
    vec2 d = vec2(0.0);
    for(int i=0;i<16;i++){
      if(i >= octaves) break;
      vec3 n = noised(p);
      d += n.yz;
      v += a * n.x / (1.0 + dot(d,d));
      a *= 0.5;
      p = m2 * p * 2.0;
    }
    return v;
  }
  float fbm(vec2 p) { return fbmErosion(p, 6); }

  uniform vec4 scorchData[16]; // x, z, radius, intensity (w<=0 = unused slot)
  uniform float scorchEmber[16]; // per-slot ember rim glow (0 = none)
  // Creature ichor stains — the tinted cousin of scorch: hit/death splats
  // paint the ground colored instead of charring it black.
  uniform vec4 splatData[24];  // x, z, radius, intensity
  uniform vec3 splatTint[24];  // per-slot ichor color
  uniform vec3 splatDir[24];   // unit smear dir xz + stretch (z=0: round pool)
  // Deployable field rings (recharge pad envelope): same projected-decal
  // trick as scorch — drawn INTO the terrain fragment, so it conforms to
  // the displaced surface exactly. A draped mesh can't: the clipmap is a
  // 5m chord approximation and any denser decal drowns under its bumps.
  uniform vec4 fieldRing[8];  // x, z, ±radius, intensity (w<=0 = unused)
  uniform vec3 fieldTint[8];  // per-slot color
  uniform float fieldY[8];    // dome-center Y for shell-contact slots

  // Projected explosion-scorch decals: darken albedo inside each scorch
  // circle with a noise-jittered edge. Applied in the fragment shader so it
  // conforms to the displaced surface exactly — no z-fighting, no decals
  // bridging dips or floating over slopes.
  float scorchMask(vec2 p) {
    float m = 0.0;
    for (int i = 0; i < 16; i++) {
      vec4 s = scorchData[i];
      if (s.w <= 0.0) continue;
      // Mostly circular blast ring with slight edge irregularity
      float edge = s.z * (0.9 + 0.15 * noise(p * 0.8 + float(i) * 7.31));
      float d = distance(p, s.xy);
      m = max(m, s.w * (1.0 - smoothstep(edge * 0.4, edge, d)));
    }
    return m;
  }

  // Ichor stains: later slots paint over earlier (chronological bleed-out),
  // coverage is the strongest single mask so overlapping pools don't blow
  // out to pure tint. A stain with a smear dir is elongated along its
  // landing velocity and throws two small satellite specks trailing it —
  // a splatter, not a circle. Returns the stain color; writes mix weight.
  vec3 splatStain(vec2 p, out float m) {
    vec3 acc = vec3(0.0);
    m = 0.0;
    for (int i = 0; i < 24; i++) {
      vec4 s = splatData[i];
      if (s.w <= 0.0) continue;
      vec3 sd = splatDir[i];
      // Shear the sample frame along the smear dir: distance measured in
      // squeezed space = ellipse stretched along travel.
      vec2 off = p - s.xy;
      vec2 dir = sd.xy;
      float along = dot(off, dir);
      vec2 perp = off - dir * along;
      float axial = along / (1.0 + sd.z);
      float d = sqrt(axial * axial + dot(perp, perp) * (1.0 + sd.z * 0.6));
      // Wobblier edge than scorch — a liquid splash, not a blast ring
      float edge = s.z * (0.8 + 0.35 * noise(p * 1.4 + float(i) * 5.17));
      float w = s.w * (1.0 - smoothstep(edge * 0.35, edge, d));
      // Satellite specks trailing the smear — real splashes throw droplets
      // past the main blot. Slot-hashed offsets, ~0.3r dots.
      if (sd.z > 0.01) {
        float fi = float(i);
        vec2 o1 = dir * s.z * (1.1 + 0.4 * fract(fi * 0.618)) + vec2(-dir.y, dir.x) * s.z * (0.5 * fract(fi * 0.317) - 0.25);
        vec2 o2 = dir * s.z * (1.6 + 0.5 * fract(fi * 0.754)) - vec2(-dir.y, dir.x) * s.z * (0.6 * fract(fi * 0.483) - 0.3);
        float s1 = 1.0 - smoothstep(0.0, s.z * 0.35, distance(p, s.xy + o1));
        float s2 = 1.0 - smoothstep(0.0, s.z * 0.25, distance(p, s.xy + o2));
        w = max(w, s.w * 0.85 * max(s1, s2));
      }
      if (w <= 0.0) continue;
      acc = mix(acc, splatTint[i], min(w * 2.0, 1.0));
      m = max(m, w);
    }
    return acc;
  }

  // Ember rim: additive orange ring at the blast edge, fades in ~1s.
  // Projected in-shader so it always sits ON the terrain — a mesh ring
  // gets eaten by surface bumps at grazing angles.
  vec3 scorchEmberGlow(vec2 p) {
    float g = 0.0;
    for (int i = 0; i < 16; i++) {
      vec4 s = scorchData[i];
      float eb = scorchEmber[i];
      if (eb <= 0.0) continue;
      float d = distance(p, s.xy);
      float ring = 1.0 - smoothstep(0.0, s.z * 0.3, abs(d - s.z * 0.7));
      g += eb * max(ring, 0.0);
    }
    return vec3(1.0, 0.45, 0.1) * min(g, 1.2);
  }

  // Field-ring decals — tinted, additive like the ember rim. Two modes
  // packed in the radius sign:
  //   r > 0: flat annulus near radius + faint interior fill (station pad)
  //   r < 0: dome CONTACT CONTOUR — |r| is a sphere radius, fieldY[i] its
  //          center height. The contact line of a half-buried sphere is
  //          where terrain height equals the lower shell's height, which
  //          is NOT a circle on slopes (uphill bites in, downhill runs
  //          wide). Comparing this fragment's own displaced height to the
  //          shell height traces the true contour — cheap, no marching.
  vec3 fieldGlow(vec3 wp) {
    vec3 g = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      vec4 s = fieldRing[i];
      if (s.w <= 0.0) continue;
      float rho = distance(wp.xz, s.xy);
      if (s.z > 0.0) {
        float band = 1.0 - smoothstep(0.0, s.z * 0.14, abs(rho - s.z * 0.9));
        float fill = (1.0 - smoothstep(s.z * 0.1, s.z, rho)) * 0.10;
        g += fieldTint[i] * s.w * (band + fill);
      } else if (rho < -s.z) {
        float R = -s.z;
        float shellY = fieldY[i] - sqrt(max(R * R - rho * rho, 0.0));
        float line = 1.0 - smoothstep(0.0, 0.7, abs(wp.y - shellY));
        g += fieldTint[i] * s.w * line * line;
      }
    }
    return g;
  }

  // --- Worley / cell noise for rocky variation ---
  float worley(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell), hash(cell+vec2(31.41,27.18)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Second Worley layer at different scale for rock complexity ---
  float worley2(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell+vec2(57.3,91.7)), hash(cell+vec2(13.4,87.2)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Triplanar noise sampling (prevents stretching on cliffs) ---
  float triplanarNoise(vec3 p, float scale) {
    vec3 w = abs(vNormal);
    w = w / (w.x + w.y + w.z);
    float nx = noise(p.zy * scale);
    float ny = noise(p.xz * scale);
    float nz = noise(p.xy * scale);
    return nx * w.x + ny * w.y + nz * w.z;
  }

  // --- Stochastic texture bombing (random detail patches) ---
  float stochastic(vec3 p, float scale, float density) {
    vec3 i = floor(p * scale);
    float sum = 0.0;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
      vec3 cell = i + vec3(x,y,z);
      vec3 rnd = vec3(hash(cell.xy), hash(cell.yz), hash(cell.zx));
      vec3 center = (cell + rnd) / scale;
      float d = length(p - center);
      if(d < 0.5) sum += 1.0 - d * 2.0;
    }
    return clamp(sum * density, 0.0, 1.0);
  }

  // --- Directional erosion noise (creates river/drainage patterns) ---
  vec3 erosionNoise(vec2 p, vec2 dir) {
    vec2 ip = floor(p);
    vec2 fp = fract(p) - 0.5;
    float va = 0.0, wt = 0.0;
    for(int i=-2;i<=1;i++) for(int j=-2;j<=1;j++){
      vec2 o = vec2(float(i), float(j));
      vec2 h = vec2(hash(ip-o), hash(ip-o+vec2(37.0,17.0))) * 0.5;
      vec2 pp = fp + o + h;
      float d = dot(pp, pp);
      float w = exp(-d * 2.0);
      float mag = dot(pp, dir);
      va += cos(mag * 6.283) * w;
      wt += w;
    }
    return vec3(va / wt, 0.0, 0.0);
  }

  float terrainErosion(vec2 p, vec2 baseSlope) {
    float e = 0.0, a = 0.5;
    vec2 dir = normalize(baseSlope + vec2(0.001));
    for(int i=0;i<5;i++){
      vec3 n = erosionNoise(p * 4.0, dir);
      e += a * n.x;
      a *= 0.5;
      p *= 2.0;
    }
    return e;
  }

  ${UNGRADE_GLSL}

  void main() {
    if (innerHalfSize > 0.0) {
      vec2 _d = vWorldPos.xz - innerGridOrigin;
      if (length(_d) < innerHalfSize) discard;
    }
    float slope  = 1.0 - clamp(vNormal.y, 0.0, 1.0);
    float height = clamp(vWorldPos.y / hscale, 0.0, 1.0);
    // Real cast shadows: 1 = lit, <1 = occluded by balls/crawlers/players
    float shadowMask = getShadowMask();

    // --- multi-scale UVs ---
    vec2 uv    = vWorldPos.xz * 0.032;
    vec2 uvMed = vWorldPos.xz * 0.14;
    vec2 uvFin = vWorldPos.xz * 0.72;

    // --- baked albedo (ported maps): texture in heightmap UV space, same
    // lighting/fog/scorch tail as the procedural palettes ---
    if (useAlbedo) {
      vec3 col = texture2D(albedoMap, fract(vWorldPos.xz / hmWorldScaleFrag)).rgb;
      if (useMats) {
        vec2 hmUV = fract(vWorldPos.xz / hmWorldScaleFrag);
        // Detail repeats 4× per alpha cell (~1.5m on t2 maps): at the full
        // 5.86m cell each tile's luminance variance lands as giant dark
        // blobs; at grain scale it reads as close-range texture.
        vec2 au = fract(vWorldPos.xz / (tileMeters * 0.25)) * vec2(0.25, 0.5);
        vec4 wA = texture2D(matAlphaA, hmUV);
        vec4 wB = texture2D(matAlphaB, hmUV);
        vec3 det =
          texture2D(matTiles, au + vec2(0.00, 0.0)).rgb * wA.r +
          texture2D(matTiles, au + vec2(0.25, 0.0)).rgb * wA.g +
          texture2D(matTiles, au + vec2(0.50, 0.0)).rgb * wA.b +
          texture2D(matTiles, au + vec2(0.75, 0.0)).rgb * wA.a +
          texture2D(matTiles, au + vec2(0.00, 0.5)).rgb * wB.r +
          texture2D(matTiles, au + vec2(0.25, 0.5)).rgb * wB.g +
          texture2D(matTiles, au + vec2(0.50, 0.5)).rgb * wB.b +
          texture2D(matTiles, au + vec2(0.75, 0.5)).rgb * wB.a;
        float wsum = wA.r + wA.g + wA.b + wA.a + wB.r + wB.g + wB.b + wB.a;
        // Luminance modulation, not color replacement: the tile's own
        // weighted mean divides its luminance so the blend adds grain
        // around neutral — the baked albedo keeps its color. Replacing
        // outright painted every material region in flat tile color.
        float tmean = tileMeans[0] * wA.r + tileMeans[1] * wA.g + tileMeans[2] * wA.b + tileMeans[3] * wA.a
                    + tileMeans[4] * wB.r + tileMeans[5] * wB.g + tileMeans[6] * wB.b + tileMeans[7] * wB.a;
        float dl = dot(det, vec3(0.299, 0.587, 0.114)) / max(tmean, 1e-3);
        float detFade = 1.0 - smoothstep(140.0, 380.0, length(vWorldPos - vCameraPos));
        col *= mix(1.0, dl, detFade * clamp(wsum, 0.0, 1.0));
      }
      float detail = noise(uvFin) * 0.5 + noise(uvMed) * 0.5;
      col *= 0.82 + 0.36 * detail;
      col *= 1.0 - scorchMask(vWorldPos.xz);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      // T2's terrain was baked/vertex-lit for a bright arcade read —
      // the procedural path's diff² curve night-falls a ported albedo,
      // so ported maps take a linear diffuse + lifted ambient instead.
      float diff = max(dot(vNormal, sunDir), 0.0);
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      col *= ambientColor * 1.35 + sunColor * diff * shadowMask + vec3(rim);
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m — geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      gl_FragColor = vec4(ungradeColor(mix(col, fogColor, fogFactor)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- desert preset (sand + dirt + rock only) ---
    if(terrainPreset == 1) {
      // Desert only needs: micro, cell, triRock, macro, medium, triDetail
      vec2 warp = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      float macro  = fbm(uv + 0.8 * warp);
      // Warp medium + micro too — unwarped fixed-frequency noise reads as
      // tiling at ground level even though nothing literally repeats
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * warp);
      float micro  = noise(uvFin + warp * 2.0) * 0.5 + noise(uvFin * 2.8 + warp * 3.5 + 1.7) * 0.5;
      float cell   = worley(uvMed * 1.4 + warp * 0.6);
      float triRock = triplanarNoise(vWorldPos, 0.22);
      float triDetail = triplanarNoise(vWorldPos, 0.85);
      // Patchiness: low-freq mask varies detail amplitude across the map so
      // every square meter doesn't share identical noise statistics
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.008));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10)
                   * (0.55 + 0.9 * patchMask);

      vec3 cDesertSand = vec3(0.78, 0.66, 0.28) + micro * vec3(0.10, 0.08, 0.02);
      vec3 cDesertRock = vec3(0.28, 0.24, 0.18) + cell * vec3(0.12, 0.10, 0.08) + triRock * vec3(0.08, 0.07, 0.05);
      vec3 cDesertCliff = vec3(0.18, 0.16, 0.12) + cell * vec3(0.10, 0.09, 0.07);
      vec3 cDirt = vec3(0.52, 0.30, 0.12) + medium * vec3(0.10, 0.06, 0.02) + cell * vec3(0.06, 0.04, 0.01);

      vec3 col = cDesertSand;
      col = mix(col, cDirt, smoothstep(0.05, 0.25, height));
      col = mix(col, cDesertRock, smoothstep(0.30, 0.60, height));
      float slopeBlend = smoothstep(0.18, 0.45, slope);
      vec3 slopeCol = mix(cDirt, cDesertCliff, smoothstep(0.30, 0.65, slope));
      col = mix(col, slopeCol, slopeBlend);
      col *= 0.86 + 0.28 * detail;
      col *= 1.0 - scorchMask(vWorldPos.xz);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      // Fog distance: dampen the DOWNWARD vertical component so terrain
      // below an airborne camera isn't over-fogged (looking down a valley,
      // ground 200m below shouldn't haze like it's 200m across the map).
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m — geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(ungradeColor(col), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- grassland preset: Ascend-bright olive grass over dirt/rock ---
    if(terrainPreset == 2) {
      // Nested domain warp (IQ's q->r->f idiom): the second warp stage is
      // what turns blobs into organic meadow/scrub regions.
      // Detail fadeout first: fixed-frequency terms at ~1m wavelength
      // shimmer into soup past mid distance AND cost real ALU — skip
      // evaluating them entirely where they can't be seen (Terrain3D's
      // octave-LOD: noise can't mip, so distance must gate the work).
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float region = fbm(uv * 0.42 + 1.1 * r);
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      // Sub-2m terms: gated, not faded — a far pixel pays zero for them.
      float micro = 0.0, blade = 0.0, triDetail = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        blade = noise(uvFin * 4.0 + r * 2.0);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      // Per-clump id hash: stable hue jitter across grass tufts (same
      // domain as a worley grid, but without the 9-tap distance loop).
      float clumpId = hash(floor(uvMed * 1.4 + r * 0.6));
      // Ridged noise for exposed rock — crease lines read as strata/scree.
      float ridged  = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0);
      ridged *= ridged;
      // Drainage: anisotropic erosion streaks following the real normal
      // — gully lines carved down slopes, not random dark blotches.
      vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
      float drainage = terrainErosion(uvMed, slopeDir);
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.008));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10)
                   * (0.45 + 1.1 * patchMask);

      // Palette: dark root greens -> bright olive tips, dry straw regions,
      // warm dirt, grey strata rock. Wide value range is what keeps it
      // from reading as flat soup at distance.
      vec3 cGrassDeep = vec3(0.22, 0.40, 0.08);
      vec3 cGrassTip  = vec3(0.52, 0.62, 0.20);
      vec3 cGrassDry  = vec3(0.45, 0.50, 0.12);
      vec3 cStraw     = vec3(0.62, 0.52, 0.18);
      vec3 cDirtG     = vec3(0.44, 0.36, 0.22);
      vec3 cDirtDark  = vec3(0.32, 0.26, 0.17);
      vec3 cRockG     = vec3(0.38, 0.34, 0.27);
      vec3 cCliffG    = vec3(0.20, 0.18, 0.14);

      // Canopy value gradient: medium noise lifts tip color over deep roots
      // — the grass field gets real dark/light structure instead of one
      // mid-olive. Clump id jitters hue so tufts aren't clones.
      vec3 grass = mix(cGrassDeep, cGrassTip, smoothstep(0.25, 0.75, medium));
      grass = mix(grass, cGrassDry, clumpId * 0.35);
      grass += blade * vec3(0.03, 0.035, 0.008) * detFade;
      grass = mix(grass, cStraw, smoothstep(0.58, 0.78, region) * 0.8);

      vec3 col = grass;
      // Dirt: only the driest cells, broken by medium noise so patches
      // stay small and ragged — big smooth blobs read as mud smears.
      float dirtMask = smoothstep(0.62, 0.74, region) * smoothstep(0.14, 0.28, height)
                     * smoothstep(0.35, 0.65, medium);
      float hollow = (1.0 - smoothstep(0.12, 0.28, height)) * 0.35;
      col = mix(col, mix(cDirtDark, cDirtG, micro), clamp(dirtMask + hollow, 0.0, 1.0));
      float wornEdge = dirtMask * (1.0 - dirtMask) * 4.0;
      col *= 1.0 - wornEdge * 0.25;
      // Ridges/high ground: ridged strata bleed in before cliff slope.
      col = mix(col, cRockG, smoothstep(0.55, 0.75, height) * (0.4 + 0.6 * ridged));
      col = mix(col, cCliffG * (0.8 + 0.4 * ridged), smoothstep(0.72, 0.92, height));

      float slopeBlend = smoothstep(0.20, 0.48, slope);
      vec3 slopeCol = mix(mix(cDirtG, cRockG, ridged), cCliffG, smoothstep(0.30, 0.65, slope));
      col = mix(col, slopeCol, slopeBlend);
      // Trough AO: fake canopy self-shadowing in micro lows — the single
      // biggest fix for "flat" procedural ground.
      // Drainage darkening: gully streaks on sloped ground only — flat
      // meadow stays clean, hillsides get carved.
      col *= 1.0 - smoothstep(0.10, 0.45, slope) * (1.0 - smoothstep(0.25, 0.75, drainage)) * 0.28;
      // Slope shading: flats lift, hillsides drop — reads as grazing light
      // on the relief itself, not just sun-on-normal.
      col *= mix(1.08, 0.78, smoothstep(0.0, 0.45, slope));
      // Continental tint: km-scale hue drift so the whole map isn't one
      // green — reads as wetter/drier sub-regions at horizon distance.
      col *= mix(vec3(0.88, 1.06, 0.82), vec3(1.10, 0.98, 0.80), smoothstep(0.30, 0.70, fbm(uv * 0.045)));
      col *= 0.90 + 0.18 * detail;
      col *= 1.0 - (1.0 - smoothstep(0.15, 0.45, micro)) * 0.08 * detFade;
      col *= 1.0 - scorchMask(vWorldPos.xz);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      // Grass sheen: grazing-angle specular lift on open meadow — turf
      // blades glint; masked off dirt, rock, and shaded faces.
      vec3 viewDir2 = normalize(vCameraPos - vWorldPos);
      float sheen = pow(max(dot(reflect(-sunDir, vNormal), viewDir2), 0.0), 14.0);
      col += sheen * (1.0 - dirtMask) * (1.0 - slopeBlend) * vec3(0.06, 0.05, 0.02) * diff;
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m — geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(ungradeColor(col), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- mixed preset: full noise suite ---
    vec2 warp = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
    float macro  = fbm(uv  + 0.8 * warp);
    float medium = fbm(uvMed + vec2(3.1, 7.4));
    float micro  = noise(uvFin) * 0.5 + noise(uvFin*2.8+1.7)*0.5;
    float cell   = worley(uvMed * 1.4);
    float cell2  = worley2(uvMed * 2.1);

    float triRock = triplanarNoise(vWorldPos, 0.22);
    float triDetail = triplanarNoise(vWorldPos, 0.85);

    float grassPatch = stochastic(vWorldPos, 0.18, 0.35);
    float rockPatch  = stochastic(vWorldPos, 0.12, 0.25);

    vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
    float drainage = terrainErosion(uvMed, slopeDir);

    float detail = macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10 + drainage*0.05;

    // --- rich saturated palette ---
    vec3 cSand  = vec3(0.68, 0.58, 0.32) + micro * vec3(0.08, 0.06, 0.02);
    vec3 cGrass = vec3(0.18, 0.52, 0.06) + medium * vec3(0.08, 0.12, 0.02) + micro * vec3(0.05, 0.07, 0.01) + grassPatch * vec3(0.04, 0.08, 0.0);
    vec3 cDry   = vec3(0.62, 0.50, 0.16) + macro * vec3(0.12, 0.10, 0.04);
    vec3 cDirt  = vec3(0.52, 0.30, 0.12) + medium * vec3(0.10, 0.06, 0.02) + cell * vec3(0.06, 0.04, 0.01);
    vec3 cRock  = vec3(0.36, 0.32, 0.26) + cell * vec3(0.14, 0.12, 0.10) + cell2 * vec3(0.08, 0.07, 0.06) + triRock * vec3(0.06, 0.05, 0.04) + rockPatch * vec3(0.08, 0.07, 0.05);
    vec3 cMoss  = vec3(0.28, 0.42, 0.14) + cell2 * vec3(0.06, 0.08, 0.02);
    vec3 cCliff = vec3(0.22, 0.20, 0.16) + cell * vec3(0.10, 0.09, 0.07) + triRock * vec3(0.08, 0.07, 0.05);
    vec3 cWet   = vec3(0.38, 0.40, 0.34);

    // --- height blend (mixed preset) ---
    vec3 col = cSand;
    col = mix(col,   cDry,   smoothstep(0.05, 0.15, height));
    col = mix(col,   cGrass, smoothstep(0.12, 0.35, height));
    col = mix(col,   cDirt,  smoothstep(0.38, 0.56, height));
    col = mix(col,   cRock,  smoothstep(0.52, 0.78, height));

    // --- slope blend ---
    float slopeBlend = smoothstep(0.18, 0.45, slope);
    vec3 slopeCol = mix(cDirt, cCliff, smoothstep(0.30, 0.65, slope));
    col = mix(col, slopeCol, slopeBlend);

    // --- moss on rocks in mid-height damp areas ---
    float mossMask = smoothstep(0.25, 0.55, height) * (1.0 - smoothstep(0.60, 0.75, height));
    float mossSlope = smoothstep(0.25, 0.50, slope);
    col = mix(col, cMoss, mossMask * mossSlope * cell2 * 0.6);

    // --- wet patches in low valleys ---
    float wetMask = smoothstep(0.0, 0.12, height) * (1.0 - smoothstep(0.18, 0.25, height));
    col = mix(col, cWet, wetMask * macro * 0.4);

    // --- drainage channels (darker, follow slope direction) ---
    float drainageMask = smoothstep(0.0, 0.6, drainage) * smoothstep(0.1, 0.8, slope);
    vec3 cDrain = vec3(0.25, 0.28, 0.22);
    col = mix(col, cDrain, drainageMask * 0.35);

    // --- micro darkening in concavities via detail ---
    col *= 0.86 + 0.28 * detail;
    col *= 1.0 - scorchMask(vWorldPos.xz);
    { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }

    // --- lighting ---
    float diff   = max(dot(vNormal, sunDir), 0.0);
    float shadow = diff * diff;
    // subtle fresnel-like rim on slopes facing away
    float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
    vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
    col *= lit;
    col += scorchEmberGlow(vWorldPos.xz);
    col += fieldGlow(vWorldPos);
    // Same dampened-downward-distance fog as the desert branch — see above
    vec3 fogDelta = vWorldPos - vCameraPos;
    float dist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
    float fogFactor = terrainFogFactor(dist);
    float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, dist) * step(0.5, edgeHalf);
    // Height-augmented fog: tall terrain at distance gets extra fog
    float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, dist)
                     * smoothstep(0.3, 0.8, height);
    float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
    fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
    col = mix(col, fogColor, fogFactor);
    gl_FragColor = vec4(ungradeColor(col), edgeA);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

