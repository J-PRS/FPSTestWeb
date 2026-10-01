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
  uniform int terrainPreset; // 0=mixed, 1=desert
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
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      col *= ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col += scorchEmberGlow(vWorldPos.xz);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = smoothstep(fogStart, fogEnd, fogDist);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      gl_FragColor = vec4(ungradeColor(mix(col, fogColor, fogFactor)), 1.0);
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
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos.xz);
      // Fog distance: dampen the DOWNWARD vertical component so terrain
      // below an airborne camera isn't over-fogged (looking down a valley,
      // ground 200m below shouldn't haze like it's 200m across the map).
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = smoothstep(fogStart, fogEnd, fogDist);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(ungradeColor(col), 1.0);
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

    // --- lighting ---
    float diff   = max(dot(vNormal, sunDir), 0.0);
    float shadow = diff * diff;
    // subtle fresnel-like rim on slopes facing away
    float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
    vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
    col *= lit;
    col += scorchEmberGlow(vWorldPos.xz);
    // Same dampened-downward-distance fog as the desert branch — see above
    vec3 fogDelta = vWorldPos - vCameraPos;
    float dist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
    float fogFactor = smoothstep(fogStart, fogEnd, dist);
    // Height-augmented fog: tall terrain at distance gets extra fog
    float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, dist)
                     * smoothstep(0.3, 0.8, height);
    float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
    fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
    col = mix(col, fogColor, fogFactor);
    gl_FragColor = vec4(ungradeColor(col), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

