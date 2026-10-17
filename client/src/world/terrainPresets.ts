// Extra terrain palettes (snow / volcanic / badlands / coast) — split out of
// terrainShaders.ts to keep that file under the ~900-line size-watch ceiling.
// Spliced INSIDE the terrain fragment shader's main() as an #elif chain on
// the compile-time TERRAIN_PRESET define (not the old runtime uniform — dead
// preset code must never reach the compiler; the six-branch monolith cost
// ~30-70s of sync D3D compile per program). Leans on the same scope: the
// varyings, derived `height`/`slope`, uv sets, noise helpers, `shadowMask`.
// Every branch returns.
export const TERRAIN_PRESET_GLSL = /* glsl */`
#elif TERRAIN_PRESET >= 3 && TERRAIN_PRESET <= 6
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
      vec3 cSnowNew  = vec3(0.88, 0.92, 0.98);
      vec3 cSnowOld  = vec3(0.72, 0.79, 0.90);
      vec3 cIceBlue  = vec3(0.50, 0.64, 0.80);
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
      col *= 0.90 + 0.20 * detail;
      col *= 1.0 + (grain - 0.5) * 0.6 * grainFade + (triGrain - 0.5) * 0.25 * grainFade;
      col += sparkle * detFade * snowMask * vec3(0.05, 0.06, 0.08);
      col *= 1.0 - scorchMask(vWorldPos.xz);
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
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
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

    // --- volcanic preset: basalt + rust + olive ash, ember-lit cracks (Caldera) ---
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

      // Value structure is the point: warm ash + rust PLAINS read LIGHT and
      // the basalt ridges read DARK, so the map keeps contrast in grayscale.
      // The single saturated accent is ember light in the ground cracks.
      vec3 cAsh      = vec3(0.56, 0.53, 0.47) + cell2 * vec3(0.09, 0.09, 0.08);
      vec3 cRust     = vec3(0.46, 0.28, 0.17) + medium * vec3(0.12, 0.07, 0.03);
      vec3 cBasalt   = vec3(0.15, 0.145, 0.15) + cell * vec3(0.08, 0.08, 0.09);
      vec3 cBasaltHi = vec3(0.30, 0.29, 0.28) + triRock * vec3(0.07, 0.07, 0.07);
      vec3 cSulphur  = vec3(0.58, 0.54, 0.30);

      float crest = smoothstep(0.45, 0.80, height);
      vec3 col = mix(cAsh, cRust, smoothstep(0.15, 0.78, medium));
      // Steep faces and ridge ribs go dark basalt.
      col = mix(col, mix(cBasalt, cBasaltHi, ridged), smoothstep(0.30, 0.62, slope));
      col = mix(col, cBasaltHi, crest * ridged * 0.5);
      col = mix(col, cSulphur, crest * smoothstep(0.5, 0.8, ridged) * 0.35);
      // Crack veins — narrow bright cells that stay in the low, flatter ground.
      float crack = smoothstep(0.80, 0.93, cell2) * (1.0 - smoothstep(0.34, 0.55, slope)) * (1.0 - crest);
      col *= 0.86 + 0.26 * detail;
      col *= 1.0 + (grain - 0.5) * 0.45 * grainFade + (triGrain - 0.5) * 0.2 * grainFade;
      col *= 1.0 - scorchMask(vWorldPos.xz);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += crack * vec3(0.70, 0.26, 0.05);
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
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

    // --- badlands preset: eroded rust/ochre/pale strata (Hoodoo) ---
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
      col *= 1.0 - scorchMask(vWorldPos.xz);
      { float splM; vec3 splC = splatStain(vWorldPos.xz, splM); col = mix(col, splC, splM); }
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
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
      col *= 1.0 - scorchMask(vWorldPos.xz);
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
      col += scorchEmberGlow(vWorldPos.xz);
      col += fieldGlow(vWorldPos);
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = terrainFogFactor(fogDist);
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
#endif
`;
