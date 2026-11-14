// Terrain GLSL - vertex displacement over the clipmap + fragment shading
// (scorch decals, fog, lighting). Kept apart from terrain.ts so the clipmap
// machinery reads without two pages of shader text.
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';
import { TERRAIN_PRESET_GLSL } from './terrainPresets.js';

export const terrainVert = /* glsl */`
  uniform sampler2D heightMap;
  uniform float hmWorldScale;
  uniform float hScale;
  uniform vec2 gridOrigin;
  uniform float levelScale;
  uniform float gridSpacing;   // REAL vertex spacing of this level's mesh
  uniform float parentSpacing; // next-coarser level's real vertex spacing (0 = outermost)
  uniform vec2 parentOrigin;   // next-coarser level's snapped gridOrigin

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  #include <shadowmap_pars_vertex>

  // R is the exact field; G/B/A carry a min-pool of it at each coarse
  // level's reach, so a coarse chord can never hang above the collider
  // (the remote-under-terrain class - heightmap.ts packLodMin). level i
  // reads channel i; the parent chord reads channel i+1.
  uniform vec4 heightSel;
  uniform vec4 parentSel;

  float sampleHeightGPU(vec2 worldXZ) {
    vec2 uv = fract(worldXZ / hmWorldScale);
    return dot(texture2D(heightMap, uv), heightSel) * hScale;
  }

  float sampleParentGPU(vec2 worldXZ) {
    vec2 uv = fract(worldXZ / hmWorldScale);
    return dot(texture2D(heightMap, uv), parentSel) * hScale;
  }

  // The parent ring's drawn surface: a two-triangle linear chord of the
  // field over the parent's coarser lattice - the SAME diagonal split the
  // flat-grid index buffer uses. (An earlier scheme morphed the COARSE
  // ring toward the fine chord instead: a linear interp between two
  // coarser-lattice chord values can never equal the fine level's 5m
  // boundary polyline, so hairline T-junction holes survived every LOD
  // edge. The classic fix welds from the FINE side - morph the outer
  // verts onto the parent's drawn surface, where they coincide by
  // construction.)
  float parentChord(vec2 worldXZ) {
    vec2 local = worldXZ - parentOrigin;
    vec2 cell0 = floor(local / parentSpacing) * parentSpacing;
    vec2 f = (local - cell0) / parentSpacing;
    vec2 c00 = parentOrigin + cell0;
    float s00 = sampleParentGPU(c00);
    float s10 = sampleParentGPU(c00 + vec2(parentSpacing, 0.0));
    float s01 = sampleParentGPU(c00 + vec2(0.0, parentSpacing));
    float s11 = sampleParentGPU(c00 + vec2(parentSpacing, parentSpacing));
    return f.x + f.y <= 1.0
      ? s00 + (s10 - s00) * f.x + (s01 - s00) * f.y
      : s11 + (s10 - s11) * (1.0 - f.y) + (s01 - s11) * (1.0 - f.x);
  }

  // Near this level's outer edge, morph field height onto the parent
  // chord - full blend at the interior edge row, so the boundary
  // polyline lies ON the parent's triangles at every vertex and the
  // discard-hole seam is watertight regardless of lattice parity.
  float getMorphHeight(vec2 worldXZ) {
    float h = sampleHeightGPU(worldXZ);
    if (parentSpacing <= 0.0) return h;
    vec2 d = abs(worldXZ - gridOrigin);
    float dist = max(d.x, d.y);
    float halfOuter = levelScale * 0.5;
    float morphStart = halfOuter - parentSpacing * 2.0;
    if (dist <= morphStart) return h;
    return mix(h, parentChord(worldXZ), smoothstep(morphStart, halfOuter, dist));
  }

  void main() {
    vec2 worldXZ = gridOrigin + position.xz * levelScale;

    float eps = gridSpacing * 0.5;
    float h = getMorphHeight(worldXZ);

    float hL = getMorphHeight(worldXZ - vec2(eps, 0.0));
    float hR = getMorphHeight(worldXZ + vec2(eps, 0.0));
    float hD = getMorphHeight(worldXZ - vec2(0.0, eps));
    float hU = getMorphHeight(worldXZ + vec2(0.0, eps));
    vNormal = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

    vec3 worldPos = vec3(worldXZ.x, h, worldXZ.y);
    vWorldPos = worldPos;
    vCameraPos = cameraPosition;

    // Shadow-receive coords - computed manually so vNormal (already
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

  // Preset is a COMPILE-TIME define (material.defines), not a uniform -
  // a runtime branch over six ~100-line palettes compiles all six into
  // every program; preprocessor exclusion means each program carries
  // only its own preset (~73KB frag measured at a 30-70s sync D3D
  // compile on the real-GPU path - the browser hang).
  #ifndef TERRAIN_PRESET
  #define TERRAIN_PRESET 0
  #endif

  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float hscale;
  uniform sampler2D albedoMap;
  uniform bool useAlbedo;
  // T2 material blend layer - real 256px tiles in a 4x2 atlas, blended
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
  uniform float fogDir; // 1 = directional sunward/away haze tint (spec.fog.dirTint)
  // Distance-gradient haze - FireWatch/COZY style: fog color rides a 1D
  // ramp of up to 6 stops keyed by normalized distance instead of one flat
  // color. xyz = stop color, w = position t in [0,1]. fogRampN = 0 → flat.
  uniform vec4 fogRamp[6];
  uniform int fogRampN;
  uniform float mistTime;  // elapsed s - scrolls the mist density field
  uniform float mistAnim;  // 0 = static mist (spec.fog.mistAnim:false)
  // Authored local fog pockets (spec.fog.volumes) - analytic ray-sphere
  // extinction, the smooth version of T2's fog bands. xyz=center, w=radius;
  // fogVolD = extinction per meter. fogVolN=0 → skip.
  uniform vec4 fogVolC[4];
  uniform float fogVolD[4];
  uniform int fogVolN;
  uniform float innerHalfSize;
  uniform vec2 innerGridOrigin;
  uniform float edgeHalf; // outermost level only: world-edge fade radius (0=off)
  uniform float waterLevel; // sea level world m - < -1e8 = dry map
  uniform vec3 waterTint;   // shallow tint pushed onto the seabed
  uniform float waterTime;  // caustic phase clock - ticked CPU-side
  // Mario Sunshine trick: the sea reads blue because the SEABED is
  // tinted, not because the surface is opaque - submerged ground grades
  // toward waterTint with depth, and the ~0.9m band just above the line
  // darkens (wet sand). One uniform does both shoreline reads.
  vec3 seaTint(vec3 col, float wy, vec2 wxz) {
    if (waterLevel < -1e8) { return col; }
    float d = waterLevel - wy;                                   // >0 submerged
    col = mix(col, waterTint, clamp(d * 0.22, 0.0, 0.75));
    if (d > 0.0) {
      // Caustic web - the sin-warp interference trick (3 iters, pure ALU):
      // curved wavefront families crossing spike filaments where they
      // reinforce = the dancing light webs sun draws through chop onto a
      // bed. Fades with depth - light can't focus through deep water.
      vec2 p = wxz * 1.6;
      vec2 k = p;
      float c = 1.0;
      for (int n = 0; n < 3; n += 1) {
        float tt = waterTime * 0.9 * (1.0 - (3.5 / float(n + 1)));
        k = p + vec2(cos(tt - k.x) + sin(tt + k.y), sin(tt - k.y) + cos(tt + k.x));
        c += 1.0 / length(vec2(p.x / (sin(k.x + tt) / 0.005), p.y / (cos(k.y + tt) / 0.005)));
      }
      c = 1.17 - pow(c / 3.0, 1.4);
      col += waterTint * pow(abs(c), 8.0) * exp(-d * 0.15) * 0.9;
    }
    float wet = clamp(1.0 + d / 0.9, 0.0, 1.0) * step(0.0, -d);
    return col * (1.0 - 0.3 * wet);
  }

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

  // Valley mist - exponential height fog integrated along the view ray.
  // Density pools near HF_FLOOR and thins exponentially with altitude, so
  // distant lowlands dissolve into haze while ridgelines stay crisp.
  // The integral is closed-form (no marching): D0*exp(-K*(ro-FLOOR)) with
  // the (1-e^-kΔy)/(k·rd.y) term handling up/down rays exactly.
  const float HF_FLOOR = 18.0;  // world-y where fog density peaks
  const float HF_K = 0.024;     // altitude falloff (1/m) - layer thins ~every 29m
  const float HF_D0 = 0.0024;   // extinction per meter at the floor
  const float HF_CAP = 0.80;    // never fully opaque - haze, not soup
  float heightFogAmount(vec3 ro, vec3 delta, float dist) {
    if (dist < 1.0) return 0.0;
    float rdy = delta.y / dist;
    float a = HF_D0 * exp(-HF_K * max(ro.y - HF_FLOOR, 0.0));
    if (mistAnim > 0.5) {
      // Drifting density - two scrolling noise octaves sampled mid-ray so
      // banks vary across the screen; wind-matched drift (~2.5m/s) shares
      // direction with the ground-mist cards and cloud decks.
      vec3 mid = ro + delta * (dist * 0.5);
      vec2 np = mid.xz * 0.008 + vec2(1.0, 0.1) * mistTime * 0.02;
      float n = noise(np) * 0.7 + noise(np * 2.7 + vec2(0.0, mistTime * 0.013)) * 0.3;
      a *= 0.55 + 0.9 * n;
    }
    float od = abs(rdy) < 1e-3
      ? a * dist
      : a * (1.0 - exp(-HF_K * rdy * dist)) / (HF_K * rdy);
    return min(1.0 - exp(-max(od, 0.0)), HF_CAP);
  }

  // Local fog volumes - each is a uniform-density sphere; the ray's chord
  // through it contributes Beer-Lambert optical depth. Hard edge is fine
  // at these densities; the ambient height mist hides the silhouette.
  float localFogAmount(vec3 ro, vec3 delta, float dist) {
    if (fogVolN <= 0 || dist < 1.0) return 0.0;
    vec3 rd = delta / dist;
    float od = 0.0;
    for (int i = 0; i < 4; i += 1) {
      if (i >= fogVolN) break;
      vec3 co = ro - fogVolC[i].xyz;
      float tca = dot(co, rd);
      float r2 = fogVolC[i].w * fogVolC[i].w;
      float d2 = dot(co, co) - tca * tca;
      if (d2 >= r2) continue;
      float thc = sqrt(r2 - d2);
      float enter = max(-tca - thc, 0.0);
      float exit = min(-tca + thc, dist);
      if (exit > enter) { od += fogVolD[i] * (exit - enter); }
    }
    return min(1.0 - exp(-od), 0.85);
  }

  // Exp² distance fog on the spec's linear start/end: near field stays
  // clean, haze rolls in on the natural 1-e^-(t²) curve. The raw curve
  // tops at ~98% - the *1.05 saturates the last ~13% of range to a true
  // 1.0 so the clipmap's far edge dissolves fully into the sky haze
  // instead of leaving a faint terrain-colored rim against it (T2 look).
  float terrainFogFactor(float dist) {
    float t = clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0);
    return min((1.0 - exp(-t * t * 4.0)) * 1.05, 1.0);
  }

  // Directional haze tint - GLSL port of directionalFog.ts fogTint(): the
  // fogged fraction warms toward the sun and cools away, approximating the
  // sky's own directional variation so fogged terrain doesn't read as a
  // flat cutout against it. fogDir uniform gates it per-map.
  vec3 fogViewColor(vec3 base, vec3 rd, vec3 sun) {
    float fwd = length(rd.xz);
    if (fwd < 1e-6) {return base;}
    float d = dot(rd.xz, sun.xz) / fwd;
    vec3 c = mix(base, vec3(1.0, 0.82, 0.55), pow(max(d, 0.0), 2.0) * 0.42);
    return mix(c, vec3(0.3, 0.55, 0.92), pow(max(-d, 0.0), 2.0) * 0.18);
  }

  // Ramp lookup: piecewise-linear over authored stops; clamps to the end
  // colors outside the authored range. Stops sorted by w on the CPU side.
  vec3 fogRampColor(float t) {
    if (fogRampN <= 0) {return fogColor;}
    if (t <= fogRamp[0].w) {return fogRamp[0].xyz;}
    for (int i = 1; i < 6; i += 1) {
      if (i >= fogRampN) {break;}
      if (t <= fogRamp[i].w) {
        float f = (t - fogRamp[i - 1].w) / max(fogRamp[i].w - fogRamp[i - 1].w, 1e-5);
        return mix(fogRamp[i - 1].xyz, fogRamp[i].xyz, clamp(f, 0.0, 1.0));
      }
    }
    return fogRamp[fogRampN - 1].xyz;
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

  // --- Band-limited detail fBm (close-range surface texture) ---
  // A single small noise is just one repeating tile. Layered octaves are what
  // read as real detail; the standard tricks that stop it looking patterned:
  //   * detuned lacunarity (2.03, not exactly 2) so octaves never line up;
  //   * a domain ROTATION per octave (m2) so their zero-crossings diverge;
  //   * a per-octave offset so the lattices don't share features;
  //   * band-limiting: an octave whose wavelength falls below the pixel
  //     footprint (~dist * pixelAngle) fades out - this doubles as the AA, so
  //     the layer can never shimmer at distance.
  // baseWl is the coarsest octave's wavelength in metres.
  float detailFbm(vec2 wp, float dist, float baseWl) {
    float v = 0.0, a = 0.5, f = 1.0;
    float pixWl = dist * 0.0022; // ≈ world size of one pixel
    for (int i = 0; i < 5; i++) {
      float wl = baseWl / f;
      float keep = smoothstep(0.0, 1.0, wl / max(pixWl, 1e-4));
      if (keep <= 0.001) break;
      v += a * keep * noise(wp / wl + vec2(float(i) * 13.7, float(i) * 7.1));
      a *= 0.55;
      f *= 2.03;
      wp = m2 * wp;
    }
    return v;
  }

  uniform vec4 scorchData[16]; // x, z, radius, intensity (w<=0 = unused slot)
  uniform float scorchEmber[16]; // per-slot ember rim glow (0 = none)
  uniform float scorchY[16];     // decal center height - sphere projection
  // Creature ichor stains - the tinted cousin of scorch: hit/death splats
  // paint the ground colored instead of charring it black.
  uniform vec4 splatData[24];  // x, z, radius, intensity
  uniform vec3 splatTint[24];  // per-slot ichor color
  uniform vec3 splatDir[24];   // unit smear dir xz + stretch (z=0: round pool)
  // Deployable field rings (recharge pad envelope): same projected-decal
  // trick as scorch - drawn INTO the terrain fragment, so it conforms to
  // the displaced surface exactly. A draped mesh can't: the clipmap is a
  // 5m chord approximation and any denser decal drowns under its bumps.
  uniform vec4 fieldRing[32]; // x, z, ±radius, intensity (w<=0 = unused)
  uniform vec3 fieldTint[32]; // per-slot color
  uniform float fieldY[32];   // dome-center Y for shell-contact slots
  // Dynamic loop bounds: constant-bound loops over uniform arrays get
  // fully unrolled by the ANGLE→D3D backend - 72 iterations of decal
  // math blew the fragment shader to 72KB and ~40s of sync compile per
  // program (measured: one getProgramParameter blocked 33s). The bound
  // itself must be a uniform - a literal bound + break still unrolls.
  uniform int scorchCount;
  uniform int splatCount;
  uniform int fieldCount;
  uniform int dbgStage; // -1 off; desert-preset stage bisect (maplab tool)
  // lit knee: sunlit sand crossing display 1.0 skips ungradeColor's
  // inverse and ACES desaturates it into pale blotches - compress the
  // smooth lit term so the noisy albedo texture survives untouched.
  uniform float litKnee;  // where compression starts (display-lit peak)
  uniform float litKeep;  // fraction of overshoot kept (contrast)
  uniform float colCap;   // hard ceiling on final lit albedo

  // Projected explosion-scorch decals: darken albedo inside each scorch
  // circle with a noise-jittered edge. Applied in the fragment shader so it
  // conforms to the displaced surface exactly - no z-fighting, no decals
  // bridging dips or floating over slopes.
  // Sphere-projected decal (3D distance to the blast center): round on
  // flats, foreshortened on cliffs. The old XZ cylinder smeared the mark
  // vertically down steep faces.
  float scorchMask(vec3 p) {
    float m = 0.0;
    for (int i = 0; i < scorchCount; i++) {
      vec4 s = scorchData[i];
      if (s.w <= 0.0) continue;
      // Mostly circular blast ring with slight edge irregularity
      float edge = s.z * (0.9 + 0.15 * noise(p.xz * 0.8 + float(i) * 7.31));
      float d = distance(p, vec3(s.x, scorchY[i], s.y));
      m = max(m, s.w * (1.0 - smoothstep(edge * 0.4, edge, d)));
    }
    return m;
  }

  // Ichor stains: later slots paint over earlier (chronological bleed-out),
  // coverage is the strongest single mask so overlapping pools don't blow
  // out to pure tint. A stain with a smear dir is elongated along its
  // landing velocity and throws two small satellite specks trailing it -
  // a splatter, not a circle. Returns the stain color; writes mix weight.
  vec3 splatStain(vec2 p, out float m) {
    vec3 acc = vec3(0.0);
    m = 0.0;
    for (int i = 0; i < splatCount; i++) {
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
      // Wobblier edge than scorch - a liquid splash, not a blast ring
      float edge = s.z * (0.8 + 0.35 * noise(p * 1.4 + float(i) * 5.17));
      float w = s.w * (1.0 - smoothstep(edge * 0.35, edge, d));
      // Satellite specks trailing the smear - real splashes throw droplets
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
  // Projected in-shader so it always sits ON the terrain - a mesh ring
  // gets eaten by surface bumps at grazing angles.
  vec3 scorchEmberGlow(vec3 p) {
    float g = 0.0;
    for (int i = 0; i < scorchCount; i++) {
      vec4 s = scorchData[i];
      float eb = scorchEmber[i];
      if (eb <= 0.0) continue;
      float d = distance(p, vec3(s.x, scorchY[i], s.y));
      float ring = 1.0 - smoothstep(0.0, s.z * 0.3, abs(d - s.z * 0.7));
      g += eb * max(ring, 0.0);
    }
    return vec3(1.0, 0.45, 0.1) * min(g, 1.2);
  }

  // Field-ring decals - tinted, additive like the ember rim. Two modes
  // packed in the radius sign:
  //   r > 0: flat annulus near radius + faint interior fill (station pad)
  //   r < 0: dome CONTACT CONTOUR - |r| is a sphere radius, fieldY[i] its
  //          center height. The contact line of a half-buried sphere is
  //          where terrain height equals the lower shell's height, which
  //          is NOT a circle on slopes (uphill bites in, downhill runs
  //          wide). Comparing this fragment's own displaced height to the
  //          shell height traces the true contour - cheap, no marching.
  vec3 fieldGlow(vec3 wp) {
    vec3 g = vec3(0.0);
    for (int i = 0; i < fieldCount; i++) {
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
      vec2 _d = abs(vWorldPos.xz - innerGridOrigin);
      if (max(_d.x, _d.y) < innerHalfSize) discard;
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
        // detFade gates the whole 10-sample block - past the fade the mix
        // multiplies by 1.0 anyway, so distant pixels skip ~10 fetches
        // (uniform-coherent branch: the fade varies smoothly, not per-texel).
        float detFade = 1.0 - smoothstep(140.0, 380.0, length(vWorldPos - vCameraPos));
        if (detFade > 0.001) {
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
          // around neutral - the baked albedo keeps its color. Replacing
          // outright painted every material region in flat tile color.
          float tmean = tileMeans[0] * wA.r + tileMeans[1] * wA.g + tileMeans[2] * wA.b + tileMeans[3] * wA.a
                      + tileMeans[4] * wB.r + tileMeans[5] * wB.g + tileMeans[6] * wB.b + tileMeans[7] * wB.a;
          float dl = dot(det, vec3(0.299, 0.587, 0.114)) / max(tmean, 1e-3);
          col *= mix(1.0, dl, detFade * clamp(wsum, 0.0, 1.0));
        }
      }
      float detail = noise(uvFin) * 0.5 + noise(uvMed) * 0.5;
      col *= 0.82 + 0.36 * detail;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      // T2's terrain was baked/vertex-lit for a bright arcade read -
      // the procedural path's diff² curve night-falls a ported albedo,
      // so ported maps take a linear diffuse + lifted ambient instead.
      float diff = max(dot(vNormal, sunDir), 0.0);
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      col *= ambientColor * 1.35 + sunColor * diff * shadowMask + vec3(rim);
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      col = seaTint(col, vWorldPos.y, vWorldPos.xz);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m - geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta))
                   + localFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      vec3 fogCol = fogRampColor(clamp((fogDist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0));
      if (fogDir > 0.5) {fogCol = fogViewColor(fogCol, fogDelta / max(length(fogDelta), 1e-3), sunDir);}
      gl_FragColor = vec4(bloomGuard(ungradeColor(mix(col, fogCol, fogFactor))), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- desert preset (sand + dirt + rock only) ---
    // 7 = same palette, hard-sun lighting (ridges): pure sun·diff², no
    // ambient/rim fill - stylized matte-painting look, and palette·sun
    // peaks ~0.9 so it can never trip the >1 HDR passthrough.
#if TERRAIN_PRESET == 1 || TERRAIN_PRESET == 7
    {
      // Desert only needs: micro, cell, triRock, macro, medium, triDetail
      vec2 warp = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      float macro  = fbm(uv + 0.8 * warp);
      // Warp medium + micro too - unwarped fixed-frequency noise reads as
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
      vec3 sPal = col;
      col *= 0.86 + 0.28 * detail;
      vec3 sDet = col;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      vec3 sDec = col;
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
#if TERRAIN_PRESET == 7
      col *= sunColor * shadow * shadowMask;
#else
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      // Compress the SMOOTH lit term, not col: the albedo noise texture
      // survives intact, only the broad sun gradient compresses.
      float litPeak = max(lit.r, max(lit.g, lit.b));
      lit *= litPeak > litKnee ? (litKnee + (litPeak - litKnee) * litKeep) / litPeak : 1.0;
      col *= lit;
      // Hard ceiling for detail spikes the lit-knee can't foresee.
      float peak = max(col.r, max(col.g, col.b));
      col *= peak > colCap ? colCap / peak : 1.0;
#endif
      vec3 sLit = col;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 sGlow = col;
      // Fog distance: dampen the DOWNWARD vertical component so terrain
      // below an airborne camera isn't over-fogged (looking down a valley,
      // ground 200m below shouldn't haze like it's 200m across the map).
      col = seaTint(col, vWorldPos.y, vWorldPos.xz);
      vec3 sSea = col;
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m - geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta))
                   + localFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      // dbgStage: freeze the pipeline at a named stage - 0 palette,
      // 1 detail, 2 decals, 3 lit, 4 glows, 5 seaTint, 6+ full (fog);
      // 7/8/9 isolate lit components (sun*diff² / ambient+rim / shadowMask).
      if (dbgStage < 0 || dbgStage == 6 || dbgStage > 9) {
        vec3 fogCol = fogRampColor(clamp((fogDist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0));
        if (fogDir > 0.5) {fogCol = fogViewColor(fogCol, fogDelta / max(length(fogDelta), 1e-3), sunDir);}
        col = mix(col, fogCol, fogFactor);
      } else if (dbgStage == 7) {
        col = sPal * (sunColor * shadow);
      } else if (dbgStage == 8) {
        col = sPal * (ambientColor + vec3(rim));
      } else if (dbgStage == 9) {
        col = sPal * vec3(shadowMask);
      } else {
        col = dbgStage == 0 ? sPal : dbgStage == 1 ? sDet : dbgStage == 2 ? sDec
            : dbgStage == 3 ? sLit : dbgStage == 4 ? sGlow : sSea;
      }
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- grassland preset: Ascend-bright olive grass over dirt/rock ---
#elif TERRAIN_PRESET == 2
    {
      // Nested domain warp (IQ's q->r->f idiom): the second warp stage is
      // what turns blobs into organic meadow/scrub regions.
      // Detail fadeout first: fixed-frequency terms at ~1m wavelength
      // shimmer into soup past mid distance AND cost real ALU - skip
      // evaluating them entirely where they can't be seen (Terrain3D's
      // octave-LOD: noise can't mip, so distance must gate the work).
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float region = fbm(uv * 0.42 + 1.1 * r);
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      // Sub-2m terms: gated, not faded - a far pixel pays zero for them.
      float micro = 0.0, blade = 0.0, triDetail = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        blade = noise(uvFin * 4.0 + r * 2.0);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      // Per-clump id hash: stable hue jitter across grass tufts (same
      // domain as a worley grid, but without the 9-tap distance loop).
      float clumpId = hash(floor(uvMed * 1.4 + r * 0.6));
      // Ridged noise for exposed rock - crease lines read as strata/scree.
      float ridged  = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0);
      ridged *= ridged;
      // Drainage: anisotropic erosion streaks following the real normal
      // - gully lines carved down slopes, not random dark blotches.
      vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
      float drainage = terrainErosion(uvMed, slopeDir);
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.008));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10)
                   * (0.45 + 1.1 * patchMask);
      // Close-range sub-metre surface grain (projected at 2m -> 14cm),
      // warped by the domain warp so it never tacks on as a grid. Stolen
      // from the snow/volcanic presets - hills had nothing below ~2m.
      float camDistG = length(vWorldPos - vCameraPos);
      float grainFadeG = 1.0 - smoothstep(50.0, 140.0, camDistG);
      float grainG = 0.0, triGrainG = 0.0;
      if (grainFadeG > 0.0) {
        grainG = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDistG, 2.0);
        triGrainG = triplanarNoise(vWorldPos, 3.4);
      }

      // Micro terms only where they can resolve: micro (uvFin ~1.4m) and
      // triGrainG (~0.3m) are fixed-frequency and NOT band-limited, so past
      // a few tens of metres they fall beneath a pixel and alias into moiré.
      // grainG (detailFbm) is band-limited and safe to carry further out.
      float nearFadeG = 1.0 - smoothstep(20.0, 70.0, camDistG);

      // Micro-relief normal. The clipmap lattice is 5m, so the ground
      // arrives smooth-shaded: grass with no light-catching grain reads as
      // matte plastic, and no amount of albedo paint can fake missing
      // relief. Rebuild a normal from the SAME close-range field the grain
      // uses, via screen-space derivatives (bump-without-tangents,
      // Mikkelsen; Terrain3D also moves clipmap normals into fragment()
      // for exactly this reason). Gated identically to the grain so it
      // fades out before it can shimmer at distance.
      vec3 nrmG = vNormal;
      float bumpGrad = 0.0;
      float bumpFadeG = 1.0 - smoothstep(30.0, 100.0, camDistG);
      if (bumpFadeG > 0.0) {
        float hB = grainG * 0.85 + (micro * 0.35 + triGrainG * 0.50) * nearFadeG;
        vec3 sX = dFdx(vWorldPos);
        vec3 sY = dFdy(vWorldPos);
        vec3 r1 = cross(sY, vNormal);
        vec3 r2 = cross(vNormal, sX);
        float det = dot(sX, r1);
        // World-space height gradient over the surface; the det division
        // makes it independent of the screen-space pixel footprint.
        vec3 grad = sign(det) * (dFdx(hB) * r1 + dFdy(hB) * r2) / max(abs(det), 1e-3);
        // Grazing fragments have a near-zero det - the gradient there is
        // unstable, so damp the bump as the surface turns away from view.
        float facingG = abs(dot(normalize(vWorldPos - vCameraPos), vNormal));
        float bAmt = bumpFadeG * smoothstep(0.10, 0.40, facingG);
        // 0.10 = the height amplitude (metres) folded into the tilt. Faded
        // in, not gated, so the normal never pops at the 100m boundary.
        nrmG = normalize(mix(vNormal, normalize(vNormal - grad * 0.10), bAmt));
        bumpGrad = length(grad) * bAmt;
      }

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
      // - the grass field gets real dark/light structure instead of one
      // mid-olive. Clump id jitters hue so tufts aren't clones.
      vec3 grass = mix(cGrassDeep, cGrassTip, smoothstep(0.25, 0.75, medium));
      grass = mix(grass, cGrassDry, clumpId * 0.35);
      grass += blade * vec3(0.03, 0.035, 0.008) * detFade;
      grass = mix(grass, cStraw, smoothstep(0.58, 0.78, region) * 0.8);

      vec3 col = grass;
      // Dirt: only the driest cells, broken by medium noise so patches
      // stay small and ragged - big smooth blobs read as mud smears.
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
      // Trough AO: fake canopy self-shadowing in micro lows - the single
      // biggest fix for "flat" procedural ground.
      // Drainage darkening: gully streaks on sloped ground only - flat
      // meadow stays clean, hillsides get carved.
      // Damp meadow gathers in the low, flat valleys - wetter/darker turf.
      float valleyMaskG = (1.0 - smoothstep(0.08, 0.30, height)) * (1.0 - smoothstep(0.12, 0.30, slope));
      float wetSpotG = smoothstep(0.40, 0.75, fbm(vWorldPos.xz * 0.012 + q * 0.4));
      col *= mix(vec3(1.0), vec3(0.72, 0.80, 0.62), valleyMaskG * wetSpotG * 0.45);
      // Sparse wildflowers - only on open meadow, never dirt/rock/cliffs.
      float flowerNoiseG = noise(uvFin * 3.8 + q * 4.0) * noise(uvFin * 7.2 + r * 2.5 + 3.1);
      float flowerMaskG = (1.0 - dirtMask) * (1.0 - slopeBlend)
                       * smoothstep(0.74, 0.90, flowerNoiseG) * detFade;
      float fhashG = hash(floor(vWorldPos.xz * 1.6 + vec2(1.7, 9.2)));
      vec3 fColG = mix(mix(vec3(0.88, 0.80, 0.22), vec3(0.82, 0.38, 0.55), step(0.33, fhashG)),
                       vec3(0.93, 0.93, 0.88), step(0.85, fhashG) * 0.6);
      col = mix(col, fColG, flowerMaskG * 0.7);
      // Pebble scatter on the bare dirt patches.
      float pebG = noise(uvFin * 2.6 + q * 3.1 + 4.7);
      float pebMaskG = smoothstep(0.80, 0.94, pebG) * detFade * dirtMask;
      col = mix(col, cRockG * 0.75, pebMaskG * 0.6);
      col *= 1.0 - smoothstep(0.10, 0.45, slope) * (1.0 - smoothstep(0.25, 0.75, drainage)) * 0.28;
      // Slope shading: flats lift, hillsides drop - reads as grazing light
      // on the relief itself, not just sun-on-normal.
      col *= mix(1.12, 0.74, smoothstep(0.0, 0.45, slope));
      float windG = 0.5 + 0.5 * sin((vWorldPos.x * 0.08 + vWorldPos.z * 0.04) + fbm(vWorldPos.xz * 0.004) * 4.0);
      col *= mix(vec3(0.96, 0.97, 0.90), vec3(1.04, 1.03, 1.00), windG) * (1.0 - slopeBlend * 0.4);
      // Continental tint: km-scale hue drift so the whole map isn't one
      // green - reads as wetter/drier sub-regions at horizon distance.
      col *= mix(vec3(0.88, 1.06, 0.82), vec3(1.10, 0.98, 0.80), smoothstep(0.30, 0.70, fbm(uv * 0.045)));
      col *= 0.88 + 0.24 * detail;
      col *= 1.0 - (1.0 - smoothstep(0.15, 0.45, micro)) * 0.10 * detFade;
      // Close-range grain finally lands on the albedo too (it used to be
      // computed and thrown away) - plus a crease darkening driven by the
      // bump gradient, so the micro-relief reads as turf, not just tint.
      col *= 1.0 + ((grainG - 0.5) * 0.38 + (triGrainG - 0.5) * 0.22 * nearFadeG) * grainFadeG;
      col *= 1.0 - clamp(bumpGrad * 0.035, 0.0, 0.22) * grainFadeG;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(nrmG, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      // Grass sheen: grazing-angle specular lift on open meadow - turf
      // blades glint; masked off dirt, rock, and shaded faces.
      vec3 viewDir2 = normalize(vCameraPos - vWorldPos);
      float sheen = pow(max(dot(reflect(-sunDir, nrmG), viewDir2), 0.0), 14.0);
      col += sheen * (1.0 - dirtMask) * (1.0 - slopeBlend) * vec3(0.06, 0.05, 0.02) * diff;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      col = seaTint(col, vWorldPos.y, vWorldPos.xz);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      // World-edge dissolve: outermost level fades to transparent over its
      // last ~300m - geometry itself dissolves over the sky, no silhouette
      // (edgeHalf=0 on inner levels => edgeA stays 1).
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta))
                   + localFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      vec3 fogCol = fogRampColor(clamp((fogDist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0));
      if (fogDir > 0.5) {fogCol = fogViewColor(fogCol, fogDelta / max(length(fogDelta), 1e-3), sunDir);}
      col = mix(col, fogCol, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

${TERRAIN_PRESET_GLSL}
#else
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
    col *= 1.0 - scorchMask(vWorldPos);
    { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }

    // --- lighting ---
    float diff   = max(dot(vNormal, sunDir), 0.0);
    float shadow = diff * diff;
    // subtle fresnel-like rim on slopes facing away
    float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
    vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
    col *= lit;
    col += scorchEmberGlow(vWorldPos);
    col += fieldGlow(vWorldPos);
    // Same dampened-downward-distance fog as the desert branch - see above
    col = seaTint(col, vWorldPos.y, vWorldPos.xz);
    vec3 fogDelta = vWorldPos - vCameraPos;
    float dist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
    float fogFactor = terrainFogFactor(dist);
    float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, dist) * step(0.5, edgeHalf);
    // Height-augmented fog: tall terrain at distance gets extra fog
    float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, dist)
                     * smoothstep(0.3, 0.8, height);
    float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta))
                   + localFogAmount(vCameraPos, fogDelta, length(fogDelta));
    fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
    vec3 fogCol = fogRampColor(clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0));
    if (fogDir > 0.5) {fogCol = fogViewColor(fogCol, fogDelta / max(length(fogDelta), 1e-3), sunDir);}
    col = mix(col, fogCol, fogFactor);
    gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
#endif
  }
`;

