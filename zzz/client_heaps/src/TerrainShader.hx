class TerrainShader extends hxsl.Shader {

  static var SRC = {

    var output : {
      var color : Vec4;
    };

    // Reuse pipeline vars already computed by BaseMesh __init__
    var transformedPosition : Vec3;
    var transformedNormal   : Vec3;
    var pixelColor          : Vec4;

    // Shader params (CPU-set uniforms)
    @param var cameraPos : Vec3;
    @param var shadowMap : Sampler2D;
    @param var shadowMatrix : Mat4;
    @param var shadowBias : Float;

    function fragment() {
      var wp = transformedPosition;
      var n  = normalize(transformedNormal);

      // --- Value noise octave 1 (large scale, for zone boundary breakup) ---
      var p1  = wp.xz * 0.25;
      var i1  = floor(p1);
      var f1  = fract(p1);
      var u1  = f1 * f1 * (vec2(3.0) - 2.0 * f1);
      var n00 = fract(sin(dot(i1 + vec2(0,0), vec2(127.1,311.7))) * 43758.5);
      var n10 = fract(sin(dot(i1 + vec2(1,0), vec2(127.1,311.7))) * 43758.5);
      var n01 = fract(sin(dot(i1 + vec2(0,1), vec2(127.1,311.7))) * 43758.5);
      var n11 = fract(sin(dot(i1 + vec2(1,1), vec2(127.1,311.7))) * 43758.5);
      var ns1 = mix(mix(n00,n10,u1.x), mix(n01,n11,u1.x), u1.y);

      // --- Value noise octave 2 (fine detail) ---
      var p2  = wp.xz * 0.60;
      var i2  = floor(p2);
      var f2  = fract(p2);
      var u2  = f2 * f2 * (vec2(3.0) - 2.0 * f2);
      var m00 = fract(sin(dot(i2 + vec2(0,0), vec2(127.1,311.7))) * 43758.5);
      var m10 = fract(sin(dot(i2 + vec2(1,0), vec2(127.1,311.7))) * 43758.5);
      var m01 = fract(sin(dot(i2 + vec2(0,1), vec2(127.1,311.7))) * 43758.5);
      var m11 = fract(sin(dot(i2 + vec2(1,1), vec2(127.1,311.7))) * 43758.5);
      var ns2 = mix(mix(m00,m10,u2.x), mix(m01,m11,u2.x), u2.y);

      // --- Value noise octave 3 (micro-variation for colour richness) ---
      var p3  = wp.xz * 0.12;
      var i3  = floor(p3);
      var f3  = fract(p3);
      var u3  = f3 * f3 * (vec2(3.0) - 2.0 * f3);
      var k00 = fract(sin(dot(i3 + vec2(0,0), vec2(311.7,127.1))) * 43758.5);
      var k10 = fract(sin(dot(i3 + vec2(1,0), vec2(311.7,127.1))) * 43758.5);
      var k01 = fract(sin(dot(i3 + vec2(0,1), vec2(311.7,127.1))) * 43758.5);
      var k11 = fract(sin(dot(i3 + vec2(1,1), vec2(311.7,127.1))) * 43758.5);
      var ns3 = mix(mix(k00,k10,u3.x), mix(k01,k11,u3.x), u3.y);

      // --- Composite noise layers ---
      var detail  = ns1 * 0.55 + ns2 * 0.30 + ns3 * 0.15;
      var warp    = ns3 * 2.0 - 1.0;   // -1..1, used to warp blend thresholds

      // --- Normal perturbation: micro-roughness from noise gradient ---
      //   breaks the plastic smooth-mesh look at close range
      var perturbStr = 0.055;
      var pn = normalize(n + vec3((ns2*2.0-1.0)*perturbStr, 0.0, (ns1*2.0-1.0)*perturbStr));

      // --- Slope (1=flat, 0=vertical) and normalised height ---
      var slope   = clamp(pn.y, 0.0, 1.0);
      var heightN = clamp(wp.y / 125.0, 0.0, 1.0);

      // --- Curvature approximation via noise contrast ---
      //   low large-scale noise = concave hollow, high = convex ridge
      //   ns3 is the coarsest octave, best proxy for macro curvature
      var curvature = ns3 * 2.0 - 1.0;                // -1..1
      var concave   = clamp(-curvature, 0.0, 1.0);
      var convex    = clamp( curvature, 0.0, 1.0);

      // --- Four base colours: sand, grass, dirt, rocky-brown ---
      // Sand: warm golden, brightened by detail
      var cSand  = vec3(0.76 + detail*0.08, 0.65 + detail*0.06, 0.38 + detail*0.04);
      // Grass: green, darker in crevices, lighter on peaks via detail
      var cGrass = vec3(0.18 + detail*0.10, 0.42 + detail*0.14, 0.10 + detail*0.04);
      // Dirt: warm brown for moderate slopes
      var cDirt  = vec3(0.42 + detail*0.10, 0.30 + detail*0.08, 0.16 + detail*0.04);
      // Rock: dark cool brown for steep/high areas
      var cRock  = vec3(0.32 + detail*0.10, 0.26 + detail*0.08, 0.18 + detail*0.05);

      // --- Step 1: slope-based dirt/grass blend (steeper = more dirt then rock) ---
      //   noise-warp the edge so boundaries are irregular, not a clean horizontal stripe
      var slopeEdgeLo = 0.52 + warp * 0.06;
      var slopeEdgeHi = 0.78 + warp * 0.05;
      var grassAmt    = smoothstep(slopeEdgeLo, slopeEdgeHi, slope);
      var col         = mix(cDirt, cGrass, grassAmt);

      // --- Step 2: very steep slopes become rocky brown ---
      var rockEdge = 0.40 + warp * 0.05;
      col = mix(cRock, col, smoothstep(rockEdge, rockEdge + 0.18, slope));

      // --- Step 3: height-based sand injection at low, flat areas ---
      //   sand shows when: low altitude AND fairly flat
      var sandH    = smoothstep(0.32 + warp*0.04, 0.50 + warp*0.03, heightN); // 0=low 1=high
      var sandFlat = smoothstep(0.60, 0.82, slope);   // flat ground gets more sand
      var sandAmt  = (1.0 - sandH) * sandFlat * 0.90; // only flat low zones
      col = mix(col, cSand, sandAmt);

      // --- Step 4: high rocky peaks go browner/darker (height lifts rock influence) ---
      var highRock = smoothstep(0.68 + warp*0.04, 0.88, heightN);
      col = mix(col, cRock, highRock * (1.0 - grassAmt) * 0.70);

      // --- Step 5: curvature tinting ---
      //   concave hollows → cooler/darker (pooled moisture, shadow)
      //   convex ridges   → warmer/lighter (bleached, dry exposure)
      col = col * mix(vec3(1.0), vec3(0.75, 0.78, 0.80), concave * 0.55);
      col = col * mix(vec3(1.0), vec3(1.10, 1.06, 1.00), convex  * 0.35);

      // --- Lighting ---
      var sunDir  = normalize(vec3(0.4, 1.0, 0.6));
      var viewDir = normalize(cameraPos - wp);

      // Wrap diffuse for softer shadows (Tribes 2 style)
      var NdotL   = clamp(dot(pn, sunDir), 0.0, 1.0);  // standard lambert
      var diffuse = NdotL;

      // Hemisphere ambient
      var skyColor   = vec3(0.52, 0.62, 0.82);
      var groundCol  = vec3(0.22, 0.20, 0.16);
      var hemiMix    = pn.y * 0.5 + 0.5;
      var ambient    = mix(groundCol, skyColor, hemiMix) * 0.55;

      var ao         = mix(0.75, 1.0, detail);

      // --- Specular: sand only, very tight (wet sand glint, not plastic) ---
      var halfDir    = normalize(sunDir + viewDir);
      var specRaw    = pow(max(dot(pn, halfDir), 0.0), 96.0);
      var spec       = specRaw * sandAmt * 0.15 * vec3(1.0, 0.97, 0.88);

      var lit = col * (ambient + diffuse * 0.75) * ao + spec;

      // --- Atmospheric fog with sun-directional warmth ---
      var fogDist    = length(transformedPosition - cameraPos);
      var fogFactor  = clamp((fogDist - 120.0) / 160.0, 0.0, 1.0);
      fogFactor      = fogFactor * fogFactor;
      var viewDotSun = clamp(dot(normalize(wp - cameraPos), sunDir), 0.0, 1.0);
      var fogBase    = vec3(0.60, 0.70, 0.85);
      var fogSun     = vec3(0.85, 0.75, 0.58);
      var fogColor   = mix(fogBase, fogSun, viewDotSun * viewDotSun * 0.55);
      var finalColor = mix(lit, fogColor, fogFactor);

      output.color = vec4(finalColor, 1.0);
    }
  };
}
