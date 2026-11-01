// Extra terrain palettes (snow / volcanic / badlands / coast) — split out of
// terrainShaders.ts to keep that file under the ~900-line size-watch ceiling.
// Spliced INSIDE the terrain fragment shader's main() as an #elif chain on
// the compile-time TERRAIN_PRESET define (not the old runtime uniform — dead
// preset code must never reach the compiler; the six-branch monolith cost
// ~30-70s of sync D3D compile per program). Leans on the same scope: the
// varyings, derived `height`/`slope`, uv sets, noise helpers, `shadowMask`.
// Every branch returns.
export const TERRAIN_PRESET_GLSL = /* glsl */`
#elif TERRAIN_PRESET >= 3 && TERRAIN_PRESET <= 9
    // Close-range surface detail. The mesh LOD is 5m and the palette features
    // run 7-31m, so without a sub-metre DETAIL LAYER the ground reads as giant
    // patches and the player feels like an ant. detailFbm() (see the shader
    // prelude) stacks rotated, detuned octaves from ~2m down to ~0.14m, so the
    // texture is detailed at every scale without being one repeating tile.
    // grainFade is the outer gate: past ~140m even the coarsest octave is
    // under a pixel, so we drop the whole layer and skip the work.
    float camDist = length(vWorldPos - vCameraPos);
    float grainFade = 1.0 - smoothstep(50.0, 140.0, camDist);

    // --- snow preset: bright glacier white over cold rock (Whiteout) ---
#if TERRAIN_PRESET == 3
    {
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float micro = 0.0, sparkle = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        sparkle = noise(uvFin * 6.0 + r * 4.0);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        // Warp the detail octaves by the existing macro warp (q) so they don't
        // read as a straight grid, then stack 2m -> ~14cm.
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float cell = worley(uvMed * 1.4 + r * 0.6);
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
      float drainage = terrainErosion(uvMed, slopeDir);
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.006));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.5 + 0.9 * patchMask);

      // Snow lives HIGH in value (never a flat mid-grey) so the map survives a
      // grayscale pass; the blue shadow side is the temperature pair. Rock only
      // shows where the slope is too steep to hold snow, or the peak is above it.
      vec3 cSnowNew  = vec3(0.72, 0.78, 0.86);
      vec3 cSnowOld  = vec3(0.58, 0.66, 0.78);
      vec3 cIceBlue  = vec3(0.40, 0.52, 0.68);
      vec3 cRockCold = vec3(0.27, 0.29, 0.36);
      vec3 cRockWarm = vec3(0.37, 0.33, 0.28);

      float snowMask = (1.0 - smoothstep(0.32, 0.62, slope)) * (1.0 - smoothstep(0.45, 0.92, height));
      vec3 col = mix(cSnowOld, cSnowNew, smoothstep(0.30, 0.72, medium));
      // Wind-scoured ice ribs — ridged noise on the exposed faces.
      col = mix(col, cIceBlue, smoothstep(0.55, 0.85, ridged) * 0.45 * (1.0 - smoothstep(0.55, 0.82, height)));
      vec3 rock = mix(cRockWarm, cRockCold, cell);
      col = mix(rock, col, snowMask);
      col = mix(col, mix(rock, cIceBlue, 0.4), smoothstep(0.26, 0.5, slope));
      col *= 1.0 - smoothstep(0.10, 0.45, slope) * (1.0 - smoothstep(0.25, 0.75, drainage)) * 0.20;
      col *= mix(1.06, 0.80, smoothstep(0.0, 0.45, slope));
      col *= 0.82 + 0.16 * detail;
      col *= 1.0 + (grain - 0.5) * 0.6 * grainFade + (triGrain - 0.5) * 0.25 * grainFade;
      col += sparkle * detFade * snowMask * vec3(0.03, 0.04, 0.06);
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      // Snow albedo × full sun clears the 1.3 bloom gate — a HARD cap
      // flickers (detail noise parks pixels right at the boundary), so
      // shoulder-compress above 0.9 instead: continuous, hue-preserving,
      // and even sunlit peaks land ~1.0 — far under the gate.
      float snowLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col *= (snowLum > 0.9 ? (0.9 + (snowLum - 0.9) * 0.15) : snowLum) / max(snowLum, 0.001);
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- volcanic preset: an ash-choked caldera at dusk. Wind-drifted pale ash
    // on the flats, near-black basalt on the walls, oxidised rust on the
    // mid-slopes, sulphur at the vents, and a molten pool glowing low in the
    // basin. Value structure still carries the map in grayscale (ash LIGHT,
    // basalt DARK); the one saturated accent is ember/magma light.
#elif TERRAIN_PRESET == 4
    {
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      float micro = 0.0, triRock = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triRock = triplanarNoise(vWorldPos, 0.22);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        // Warp the detail octaves by the existing macro warp (q) so they don't
        // read as a straight grid, then stack 2m -> ~14cm.
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float cell = worley(uvMed * 1.4 + r * 0.6);
      float cell2 = worley2(uvMed * 2.1 + r * 0.4);
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.007));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.5 + 0.9 * patchMask);

      // The caldera field is centred on the world origin, so a radial term
      // cheaply marks the basin (ash apron + molten pool).
      float rW = length(vWorldPos.xz);
      float inBasin = 1.0 - smoothstep(215.0, 360.0, rW);
      float flatness = 1.0 - smoothstep(0.10, 0.40, slope);
      // Wind-drifted ash ripples over the flats.
      float drift = noise(vWorldPos.xz * 0.055 + q * 0.8) * 0.5 + noise(vWorldPos.xz * 0.13 + r * 0.5) * 0.5;

      vec3 cAshDk    = vec3(0.33, 0.30, 0.27);
      vec3 cAshLt    = vec3(0.64, 0.59, 0.52);
      vec3 cRust     = vec3(0.44, 0.24, 0.13);
      vec3 cBasalt   = vec3(0.115, 0.11, 0.115) + cell * vec3(0.05, 0.05, 0.06);
      vec3 cBasaltHi = vec3(0.27, 0.26, 0.26) + triRock * vec3(0.07, 0.07, 0.07);
      vec3 cSulphur  = vec3(0.60, 0.54, 0.25);

      float crest = smoothstep(0.50, 0.82, height);
      // Base: drifted ash grading into rust on the mid-ground.
      vec3 col = mix(cAshDk, cAshLt, drift);
      col = mix(col, cRust, smoothstep(0.30, 0.80, medium) * 0.7);
      // Ash apron: the basin floor stays pale and dusty where it is flat.
      col = mix(col, mix(cAshDk, cAshLt, drift * 1.15), inBasin * flatness * 0.55);
      // Walls and ridge ribs go near-black basalt; crests catch a little light.
      col = mix(col, mix(cBasalt, cBasaltHi, ridged), smoothstep(0.28, 0.60, slope));
      col = mix(col, cBasaltHi, crest * ridged * 0.55);
      col = mix(col, cSulphur, crest * smoothstep(0.55, 0.85, ridged) * 0.30);
      // Crack veins — narrow bright cells in the low, flat ground.
      float crack = smoothstep(0.80, 0.93, cell2) * flatness * (1.0 - crest);
      col *= 0.86 + 0.26 * detail;
      col *= 1.0 + (grain - 0.5) * 0.45 * grainFade + (triGrain - 0.5) * 0.2 * grainFade;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }

      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;

      // Molten pool — the deepest, flattest ground inside the basin. Emissive:
      // it reads through the sun term, hot yellow at the core, cooling to red.
      float deep   = 1.0 - smoothstep(0.055, 0.20, height);
      float molten = deep * inBasin * (1.0 - smoothstep(0.22, 0.50, slope));
      molten *= 0.55 + 0.45 * noise(vWorldPos.xz * 0.09 + q);
      vec3 lavaCol = mix(vec3(0.85, 0.17, 0.02), vec3(1.0, 0.60, 0.12), detail * 0.7 + 0.3);
      col = mix(col, lavaCol, clamp(molten * 1.25, 0.0, 0.92));
      col += lavaCol * clamp(molten, 0.0, 1.0) * 0.55;
      // Ember veins glow warmer as they near the basin.
      col += crack * vec3(0.72, 0.25, 0.05) * (0.55 + 0.45 * inBasin);

      // Obsidian sheen — grazing specular on the steep dark faces.
      vec3 viewDirV = normalize(vCameraPos - vWorldPos);
      float sheen = pow(max(dot(reflect(-sunDir, vNormal), viewDirV), 0.0), 22.0);
      col += sheen * smoothstep(0.42, 0.72, slope) * vec3(0.10, 0.09, 0.12);

      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- badlands preset: eroded rust/ochre/pale strata (Rimrock) ---
#elif TERRAIN_PRESET == 5
    {
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      float micro = 0.0, triRock = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triRock = triplanarNoise(vWorldPos, 0.22);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        // Warp the detail octaves by the existing macro warp (q) so they don't
        // read as a straight grid, then stack 2m -> ~14cm.
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float cell = worley(uvMed * 1.4 + r * 0.6);
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
      float drainage = terrainErosion(uvMed, slopeDir);
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.006));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.5 + 0.9 * patchMask);

      // Strata: quantize HEIGHT into bands, warped by macro/micro noise so the
      // seams look eroded, not painted. Per-band hash picks the pale/warm seam
      // so no two ledges share a colour, while value still steps band-to-band.
      float band = height * 12.0 + macro * 0.7 + micro * 0.2;
      float bi = floor(band);
      float bf = smoothstep(0.0, 0.20, fract(band));
      vec3 cRust  = vec3(0.50, 0.28, 0.17);
      vec3 cOchre = vec3(0.69, 0.52, 0.29);
      vec3 cPale  = vec3(0.77, 0.71, 0.61);
      vec3 bandA = mix(cRust, cOchre, abs(fract(bi * 0.37) - 0.5) * 2.0);
      vec3 bandB = mix(cOchre, cPale, abs(fract(bi * 0.61) - 0.5) * 2.0);
      vec3 col = mix(bandA, bandB, fract(bi * 0.5));
      // Seam AO — the dark line where one ledge meets the next.
      col *= 0.70 + 0.46 * bf;
      col = mix(col, cRust * 0.8, (1.0 - smoothstep(0.10, 0.30, height)) * 0.4);
      col = mix(col, cPale, smoothstep(0.80, 0.98, height) * 0.35);
      col = mix(col, mix(cRust, cOchre, ridged) * 0.9, smoothstep(0.24, 0.5, slope));
      // Scree aprons at the foot of the walls.
      col = mix(col, cOchre * (0.85 + 0.3 * micro), (1.0 - smoothstep(0.20, 0.55, slope)) * (1.0 - smoothstep(0.15, 0.35, height)) * 0.35);
      col *= 1.0 - smoothstep(0.10, 0.45, slope) * (1.0 - smoothstep(0.25, 0.75, drainage)) * 0.18;
      col *= mix(1.07, 0.82, smoothstep(0.0, 0.45, slope));
      col *= 0.90 + 0.20 * detail;
      col *= 1.0 + (grain - 0.5) * 0.45 * grainFade + (triGrain - 0.5) * 0.2 * grainFade;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- coast preset: sea-grass over sand beaches and shallow lagoon water
    // (Lagoon). Water/beach/grass are HEIGHT bands so the shoreline reads from
    // any angle; the thresholds assume the map's heightScale spreads the
    // island top to ~height 0.27 (see maps/lagoon.json). ---
#elif TERRAIN_PRESET == 6
    {
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float micro = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        // Warp the detail octaves by the existing macro warp (q) so they don't
        // read as a straight grid, then stack 2m -> ~14cm.
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float clumpId = hash(floor(uvMed * 1.4 + r * 0.6));
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.006));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.45 + 1.0 * patchMask);

      vec3 cWater   = vec3(0.22, 0.38, 0.44);
      vec3 cShallow = vec3(0.36, 0.58, 0.58);
      vec3 cWetSand = vec3(0.58, 0.52, 0.39);
      vec3 cDrySand = vec3(0.82, 0.74, 0.55);
      vec3 cGrassD  = vec3(0.26, 0.44, 0.12);
      vec3 cGrassT  = vec3(0.57, 0.65, 0.25);
      vec3 cStraw   = vec3(0.67, 0.57, 0.23);
      vec3 cRockC   = vec3(0.36, 0.34, 0.30);

      float ripple = noise(uvFin * 3.0 + q * 2.0) * 0.5 + noise(uvFin * 7.0 + r) * 0.5;
      vec3 water = mix(cWater, cShallow, smoothstep(0.010, 0.042, height) + ripple * 0.12);
      vec3 grass = mix(cGrassD, cGrassT, smoothstep(0.20, 0.75, medium));
      grass = mix(grass, cStraw, clumpId * 0.3);

      vec3 col = water;
      col = mix(col, cWetSand, smoothstep(0.045, 0.072, height));
      col = mix(col, cDrySand, smoothstep(0.072, 0.100, height));
      col = mix(col, grass,   smoothstep(0.100, 0.170, height));
      col = mix(col, cRockC,  smoothstep(0.24, 0.31, height) * 0.6);
      // Cliffs: rock where steep, but never below the waterline.
      col = mix(col, mix(cRockC, cDrySand, 0.3), smoothstep(0.28, 0.55, slope) * smoothstep(0.10, 0.18, height));
      col *= mix(1.06, 0.84, smoothstep(0.0, 0.45, slope));
      col *= 0.90 + 0.18 * detail;
      // Grain only on dry ground — water stays smooth (its ripples read as ripples).
      col *= 1.0 + ((grain - 0.5) * 0.42 + (triGrain - 0.5) * 0.2) * grainFade * smoothstep(0.05, 0.10, height);
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      // Water glint — grazing specular only on the low water band.
      vec3 viewDirC = normalize(vCameraPos - vWorldPos);
      float glint = pow(max(dot(reflect(-sunDir, vNormal), viewDirC), 0.0), 24.0);
      col += glint * (1.0 - smoothstep(0.05, 0.10, height)) * vec3(0.22, 0.26, 0.26);
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- crag preset: storm-swept granite arena. Dark slate walls,
    // pale wind-scoured scree on the tops, olive moss in the flat
    // hollows, crevice lines on steep faces — cooler and greyer than
    // the canyon strata, the "jagged rock field" skin (Vortex/Ridges).
    // NOTE: preset 7 had no branch — vortex+ridges rendered undefined
    // fragments (fell inside the >=3<=9 gate past every elif). ---
#elif TERRAIN_PRESET == 7
    {
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      float micro = 0.0, triRock = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triRock = triplanarNoise(vWorldPos, 0.22);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float cell = worley(uvMed * 1.4 + r * 0.6);
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.006));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.5 + 0.9 * patchMask);

      vec3 cSlateD = vec3(0.19, 0.20, 0.24);   // shadowed wall
      vec3 cSlateW = vec3(0.34, 0.33, 0.32);   // lit wall, slight warm
      vec3 cScree  = vec3(0.58, 0.55, 0.46);   // pale scoured tops
      vec3 cMossD  = vec3(0.14, 0.21, 0.09);   // sheltered hollow moss
      vec3 cMossT  = vec3(0.38, 0.42, 0.22);
      vec3 cTalus  = vec3(0.46, 0.42, 0.35);   // wall-toe scree fans

      float warpedH = height + (macro - 0.5) * 0.10 + (medium - 0.5) * 0.05;
      float flat2   = 1.0 - smoothstep(0.28, 0.55, slope);
      float onTop   = smoothstep(0.52, 0.74, warpedH);
      float onFloor = 1.0 - smoothstep(0.16, 0.38, warpedH);

      vec3 rock = mix(cSlateD, cSlateW, cell * 0.6 + triRock * 0.4);
      // Crevice lines: worley-edge darkening on the steeper faces.
      float crack = smoothstep(0.78, 0.92, abs(sin(medium * 9.0 + macro * 5.0)));
      rock *= 1.0 - crack * 0.22;
      vec3 moss = mix(cMossD, cMossT, smoothstep(0.25, 0.75, medium));
      vec3 scree = mix(cTalus, cScree, smoothstep(0.3, 0.8, ridged));

      vec3 col = rock;
      col = mix(col, scree, flat2 * onTop);
      col = mix(col, moss, flat2 * onFloor * smoothstep(0.3, 0.7, patchMask));
      // Talus aprons where a wall's toe meets gentler ground.
      col = mix(col, cTalus, flat2 * (1.0 - onTop) * (1.0 - onFloor) * 0.5);
      col *= mix(1.06, 0.82, smoothstep(0.0, 0.5, slope));
      col *= 0.90 + 0.20 * detail;
      col *= 1.0 + (grain - 0.5) * 0.45 * grainFade + (triGrain - 0.5) * 0.2 * grainFade;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- canyon preset: stratified mesas. SLOPE is the rock gate, HEIGHT
    // picks flat-top grass vs floor sand: green table tops, bare rock
    // walls, sand in the basins — the strata read is topographic, not
    // painted bands (Strata map). ---
#elif TERRAIN_PRESET == 8
    {
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float detFade = 1.0 - smoothstep(350.0, 900.0, length(vWorldPos - vCameraPos));
      float micro = 0.0, triRock = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triRock = triplanarNoise(vWorldPos, 0.22);
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float cell = worley(uvMed * 1.4 + r * 0.6);
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.006));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10) * (0.5 + 0.9 * patchMask);

      // The three strata. Walls grab first (steep is rock regardless of
      // height); flat ground then splits by height into top grass /
      // basin sand. Band edges are warped by macro+medium noise so the
      // grassline and the talus apron read eroded, not level-set.
      vec3 cGrassD = vec3(0.17, 0.38, 0.08);
      vec3 cGrassT = vec3(0.44, 0.60, 0.16);
      vec3 cStraw  = vec3(0.60, 0.52, 0.20);
      vec3 cRockW  = vec3(0.44, 0.30, 0.20);   // warm canyon stone
      vec3 cRockC  = vec3(0.36, 0.33, 0.28);   // cooler shade rock
      vec3 cSandD  = vec3(0.55, 0.46, 0.32);
      vec3 cSandL  = vec3(0.79, 0.70, 0.52);

      float warpedH = height + (macro - 0.5) * 0.10 + (medium - 0.5) * 0.05;
      float flat2   = 1.0 - smoothstep(0.20, 0.48, slope);
      float onTop   = smoothstep(0.46, 0.62, warpedH);   // mesa-table height
      float onFloor = 1.0 - smoothstep(0.18, 0.38, warpedH); // basin height

      vec3 grass = mix(cGrassD, cGrassT, smoothstep(0.20, 0.75, medium));
      grass = mix(grass, cStraw, cell * 0.25);
      // Wind drift: pale streaks across the flats.
      float drift = noise(vWorldPos.xz * 0.055 + q * 0.8) * 0.5 + noise(vWorldPos.xz * 0.13 + r * 0.5) * 0.5;
      vec3 sand = mix(cSandD, cSandL, drift);
      vec3 rock = mix(cRockW, cRockC, cell) * (0.9 + 0.25 * triRock);
      // Strata seam lines across the walls — thin pale/dark ledger bands.
      float seam = smoothstep(0.82, 0.95, abs(sin(warpedH * 44.0 + medium * 4.0)));
      rock = mix(rock, cSandL * 0.9, seam * 0.35);

      vec3 col = sand;
      // Mid-flats (talus benches between floor and top) grade sand→grass.
      col = mix(col, mix(sand, grass, 0.55), flat2 * smoothstep(0.32, 0.58, warpedH) * (1.0 - onTop));
      col = mix(col, grass, flat2 * onTop);
      col = mix(col, rock, 1.0 - flat2);
      // Scree: sandy apron where a wall's toe meets the floor.
      col = mix(col, sand, flat2 * onFloor * smoothstep(0.15, 0.40, slope) * 0.4);
      col *= mix(1.07, 0.84, smoothstep(0.0, 0.45, slope));
      col *= 0.90 + 0.20 * detail;
      col *= 1.0 + (grain - 0.5) * 0.45 * grainFade + (triGrain - 0.5) * 0.2 * grainFade;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // --- arcane preset: Elysium meadow — indigo/violet fae-grass, blue
    // meadow regions, pockets of ordinary green in the hollows, lilac
    // stone, and ley veins that emit their own light (Wyrd). ---
#elif TERRAIN_PRESET == 9
    {
      float detFade = 1.0 - smoothstep(350.0, 900.0, camDist);
      vec2 q = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      vec2 r = vec2(fbm(uv + 2.0 * q + vec2(1.7, 9.2)), fbm(uv + 2.0 * q + vec2(8.3, 2.8)));
      float region = fbm(uv * 0.22 + 1.1 * r);
      float macro  = fbm(uv + 0.8 * q);
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * q);
      float micro = 0.0, triDetail = 0.0, grain = 0.0, triGrain = 0.0;
      if (detFade > 0.0) {
        micro = noise(uvFin + q * 2.0) * 0.5 + noise(uvFin * 2.8 + r * 3.5 + 1.7) * 0.5;
        triDetail = triplanarNoise(vWorldPos, 0.85);
      }
      if (grainFade > 0.0) {
        grain = detailFbm(vWorldPos.xz + (q - 0.5) * 6.0, camDist, 2.0);
        triGrain = triplanarNoise(vWorldPos, 3.4);
      }
      float ridged = 1.0 - abs(2.0 * fbm(uvMed * 1.9 + r) - 1.0); ridged *= ridged;
      float detail = macro * 0.45 + medium * 0.35 + micro * 0.10 + triDetail * 0.10;

      vec3 cFaeDeep = vec3(0.20, 0.16, 0.44);   // indigo roots
      vec3 cFaeTip  = vec3(0.52, 0.42, 0.80);   // violet canopy
      vec3 cTeal    = vec3(0.10, 0.52, 0.56);   // teal meadow regions
      vec3 cGold    = vec3(0.72, 0.55, 0.15);   // amber fae-fields
      vec3 cGoldTip = vec3(0.95, 0.78, 0.30);
      vec3 cGreen   = vec3(0.24, 0.42, 0.10);   // ordinary grass pockets
      vec3 cGreenTip= vec3(0.50, 0.60, 0.20);
      vec3 cStoneA  = vec3(0.52, 0.50, 0.66);   // lilac stone
      vec3 cCliff   = vec3(0.18, 0.16, 0.26);

      // Landform-driven zones — every hue answers "what is this ground",
      // not "what does the noise say": valleys pool teal wyrm-moss,
      // mid slopes carry the violet canopy, high flats go amber, and
      // stone only claims the steep. fbm wobbles boundaries so nothing
      // reads as a contour ring; noise picks WITHIN a zone, never the zone.
      float valley  = (1.0 - smoothstep(0.10, 0.32, height)) * (1.0 - smoothstep(0.08, 0.30, slope));
      float midslope= smoothstep(0.12, 0.38, height) * (1.0 - smoothstep(0.42, 0.72, height));
      float upland  = smoothstep(0.52, 0.74, height) * (1.0 - smoothstep(0.10, 0.32, slope));
      float ridge   = smoothstep(0.30, 0.55, slope) + smoothstep(0.62, 0.85, height) * smoothstep(0.25, 0.5, slope);
      vec3 grass = mix(cFaeDeep, cFaeTip, smoothstep(0.25, 0.75, medium));
      grass = mix(grass, cTeal * (0.7 + 0.6 * medium), smoothstep(0.35, 0.75, valley));
      grass = mix(grass, mix(cGold, cGoldTip, smoothstep(0.25, 0.75, medium)), smoothstep(0.45, 0.8, upland) * 0.9);
      // mundane green pockets only where the canopy is thin
      float greenMask = smoothstep(0.55, 0.7, fbm(uv * 0.9 + q * 0.5 + 2.7)) * midslope * 0.5;
      grass = mix(grass, mix(cGreen, cGreenTip, smoothstep(0.25, 0.75, medium)), greenMask);

      vec3 col = grass;
      col = mix(col, cStoneA * (0.85 + 0.3 * triDetail), smoothstep(0.55, 0.78, height) * (0.4 + 0.6 * ridged));
      float slopeBlend = smoothstep(0.20, 0.48, slope);
      // Rock faces carry their own value range — wyrd is ~27% steep, so a
      // dark slopeCol turns half the map into a featureless night wall.
      vec3 rockFace = mix(cFaeDeep * 0.9, cStoneA * (0.75 + 0.5 * triDetail), 0.35 + 0.5 * ridged);
      vec3 slopeCol = mix(rockFace, cCliff, smoothstep(0.34, 0.70, slope));
      col = mix(col, slopeCol, slopeBlend);
      col *= mix(1.18, 0.72, smoothstep(0.0, 0.45, slope));
      col *= mix(vec3(0.86, 0.94, 1.10), vec3(1.08, 0.90, 1.04), smoothstep(0.30, 0.70, fbm(uv * 0.045)));
      col *= 0.85 + 0.30 * detail;
      col *= 1.0 + ((grain - 0.5) * 0.50 + (triGrain - 0.5) * 0.30) * grainFade;
      col *= 1.0 - scorchMask(vWorldPos);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      // Bioluminescence lives in the LANDFORM, not a wash: valley floors
      // smoulder in their own hue, ridge spines barely shimmer. Flat
      // additive glow everywhere just greys the palette.
      col += grass * (0.34 + 0.22 * medium) * valley;
      col += grass * 0.10 * midslope;
      // Faint cool ambient lift so shadowed faces never go black.
      col += vec3(0.020, 0.018, 0.045) * (0.6 + 0.4 * medium);

      // Ley veins EMIT along terrain fault lines — ridged noise seams
      // gated to ridge spines and valley seams, where a magical vein
      // would actually outcrop. Violet cores on ridges, cyan in valleys.
      float leyBase = 1.0 - abs(2.0 * fbm(uvMed * 0.9 + q * 0.6 + 4.1) - 1.0);
      float leyRidge = smoothstep(0.45, 0.75, ridge) ;
      float leyValley = smoothstep(0.45, 0.75, valley) * (1.0 - slopeBlend);
      float ley = smoothstep(0.96, 0.995, leyBase)
          * max(leyRidge, leyValley)
          * smoothstep(0.40, 0.68, fbm(uvMed * 0.5 + 1.3))
          * (1.0 - smoothstep(200.0, 600.0, camDist) * 0.6);
      col += ley * mix(vec3(0.45, 0.20, 0.95), vec3(0.20, 0.65, 1.0), leyValley) * 0.7;
      // Spore motes drift off the glowing valleys — source matches cause.
      float mote = noise(uvFin * 3.8 + q * 4.0) * noise(uvFin * 7.2 + r * 2.5 + 3.1);
      col += vec3(0.55, 0.75, 0.95) * smoothstep(0.78, 0.92, mote) * valley * detFade * 0.45;
      col += scorchEmberGlow(vWorldPos);
      col += fieldGlow(vWorldPos);
      col = seaTint(col, vWorldPos.y, vWorldPos.xz);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
      float edgeA = 1.0 - smoothstep(edgeHalf * 0.55, edgeHalf * 0.96, fogDist) * step(0.5, edgeHalf);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      float mist = heightFogAmount(vCameraPos, fogDelta, length(fogDelta));
      fogFactor = clamp(fogFactor + heightFog + mist * (1.0 - fogFactor), 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(bloomGuard(ungradeColor(col)), edgeA);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }
#endif
`;
