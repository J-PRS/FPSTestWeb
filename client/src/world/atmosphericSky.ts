import * as THREE from 'three';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';

// Atmospheric scattering shader based on wwwtyro/glsl-atmosphere
// Rayleigh and Mie scattering for realistic sky colors

const atmosphereVertexShader = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Real Rayleigh/Mie single-scattering (wwwtyro/glsl-atmosphere), the same
// technique Unity's procedural skybox is based on. Produces a physically
// plausible gradient — deep zenith, pale horizon, natural warmth toward the
// sun — without hand-tuned color bands.
const atmosphereFragmentShader = /* glsl */`
  varying vec3 vDir;
  uniform vec3 fogColor;      // ground fog — the h=0 seam must equal saturated terrain exactly
  uniform vec3 horizonColor;  // map-painted horizon tint, drifts in just above the seam
  uniform vec3 sunPosition;   // world-space sun position (used for direction only)
  uniform float sunIntensity;
  uniform float rayleigh;
  uniform float mieCoefficient;
  uniform float mieDirectionalG;
  uniform float rayleighDirectional;
  uniform float starIntensity;

  #define PI 3.141592
  #define iSteps 16
  #define jSteps 8
  ${UNGRADE_GLSL}

  float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  // ray-sphere intersection, sphere centered at origin
  vec2 rsi(vec3 r0, vec3 rd, float sr) {
    float a = dot(rd, rd);
    float b = 2.0 * dot(rd, r0);
    float c = dot(r0, r0) - (sr * sr);
    float d = (b * b) - 4.0 * a * c;
    if (d < 0.0) return vec2(1e5, -1e5);
    return vec2(
      (-b - sqrt(d)) / (2.0 * a),
      (-b + sqrt(d)) / (2.0 * a)
    );
  }

  vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun, float iSun, float rPlanet, float rAtmos,
                  vec3 kRlh, float kMie, float shRlh, float shMie, float g, float rlhDir) {
    pSun = normalize(pSun);
    r = normalize(r);

    vec2 p = rsi(r0, r, rAtmos);
    if (p.x > p.y) return vec3(0.0);
    p.y = min(p.y, rsi(r0, r, rPlanet).x);
    float iStepSize = (p.y - p.x) / float(iSteps);

    float iTime = 0.0;
    vec3 totalRlh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    float iOdRlh = 0.0;
    float iOdMie = 0.0;

    float mu = dot(r, pSun);
    float mumu = mu * mu;
    float gg = g * g;
    // rlhDir=1: physical dipole (bright toward+away from sun); 0: flat.
    float pRlh = 3.0 / (16.0 * PI) * (1.0 + mumu * rlhDir);
    float pMie = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0))
      / (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));

    for (int i = 0; i < iSteps; i++) {
      vec3 iPos = r0 + r * (iTime + iStepSize * 0.5);
      float iHeight = length(iPos) - rPlanet;
      float odStepRlh = exp(-iHeight / shRlh) * iStepSize;
      float odStepMie = exp(-iHeight / shMie) * iStepSize;
      iOdRlh += odStepRlh;
      iOdMie += odStepMie;

      float jStepSize = rsi(iPos, pSun, rAtmos).y / float(jSteps);
      float jTime = 0.0;
      float jOdRlh = 0.0;
      float jOdMie = 0.0;
      for (int j = 0; j < jSteps; j++) {
        vec3 jPos = iPos + pSun * (jTime + jStepSize * 0.5);
        float jHeight = length(jPos) - rPlanet;
        jOdRlh += exp(-jHeight / shRlh) * jStepSize;
        jOdMie += exp(-jHeight / shMie) * jStepSize;
        jTime += jStepSize;
      }

      vec3 attn = exp(-(kMie * (iOdMie + jOdMie) + kRlh * (iOdRlh + jOdRlh)));
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      iTime += iStepSize;
    }

    return iSun * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    // Earth-like atmosphere, observer at surface
    vec3 color = atmosphere(
      dir,
      vec3(0.0, 6372e3, 0.0),           // ray origin: planet surface
      sunPosition,
      sunIntensity,
      6371e3,                            // planet radius (m)
      6471e3,                            // atmosphere radius (m)
      vec3(5.5e-6, 13.0e-6, 22.4e-6) * rayleigh, // Rayleigh coefficients
      mieCoefficient,                    // Mie coefficient
      8e3,                               // Rayleigh scale height
      1.2e3,                             // Mie scale height
      mieDirectionalG,                   // Mie preferred direction
      rayleighDirectional                // Rayleigh dipole strength (0 = flat)
    );

    // Soft exposure curve (the raw HDR output needs tonemapping)
    color = 1.0 - exp(-1.6 * color);

    // Saturation boost — physical scattering trends toward hazy teal;
    // push toward the vivid royal blue of a stylized/game sky.
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 1.6);
    // Hue shift toward royal blue — raw Rayleigh reads too cyan/green
    color.g *= 0.90;
    color.b *= 1.18;
    color = clamp(color, 0.0, 1.0);

    // Two-stop haze: h=0 is exactly the ground fog color so saturated
    // terrain meets the sky color-for-color; the map's painted horizon
    // tint owns the band just above it, then the real atmosphere takes
    // over. One-stop blends fed the horizon tint AT the seam — a bluer
    // spec horizon re-cut the line the fog saturation fixed.
    vec3 haze = mix(fogColor, horizonColor, smoothstep(0.0, 0.05, h));
    color = mix(haze, color, smoothstep(0.0, 0.2, h));

    // No sun disc — Tribes-style tracking needs uniform sky brightness.
    // sunPosition only suppresses stars near the sun direction below.
    float sunDot = max(dot(dir, normalize(sunPosition)), 0.0);

    // Stars: sparse cell-hashed pinpoints, fading in above the haze.
    if (h > 0.05) {
      vec3 cell = floor(dir * 220.0);
      vec3 f = fract(dir * 220.0) - 0.5;
      float rnd = hash3(cell);
      float star = smoothstep(0.22, 0.0, length(f)) * step(0.988, rnd);
      float twinkle = 0.7 + 0.3 * hash3(cell + 1.7);
      float fade = smoothstep(0.35, 0.6, h) * (1.0 - pow(sunDot, 6.0));
      color += vec3(1.0, 1.0, 0.95) * star * twinkle * fade * starIntensity;
    }

    gl_FragColor = vec4(ungradeColor(color), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface AtmosphericSkyParams {
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  rayleighDirectional?: number;
  sunIntensity?: number;
  fogColor?: THREE.Color;
  starIntensity?: number;
}

export class AtmosphericSky {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private sunPosition: THREE.Vector3;
  private timeOfDay: number = 0.5; // 0-1, 0.5 = noon

  constructor(scene: THREE.Scene, params: AtmosphericSkyParams = {}) {
    const geometry = new THREE.SphereGeometry(4000, 64, 32);
    
    this.sunPosition = new THREE.Vector3(0, 1, 0);
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        sunPosition: { value: this.sunPosition },
        sunIntensity: { value: params.sunIntensity ?? 22 },
        rayleigh: { value: params.rayleigh ?? 1 },
        mieCoefficient: { value: params.mieCoefficient ?? 21e-6 },
        mieDirectionalG: { value: params.mieDirectionalG ?? 0.758 },
        rayleighDirectional: { value: params.rayleighDirectional ?? 1 },
        turbidity: { value: params.turbidity ?? 10 },
        fogColor: { value: params.fogColor ?? new THREE.Color(0xBB_D0_E8) },
        horizonColor: { value: params.fogColor?.clone() ?? new THREE.Color(0xBB_D0_E8) },
        starIntensity: { value: params.starIntensity ?? 0.9 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = '__sky'; // map specs with a baked skybox hide this
    scene.add(this.mesh);
    
    // Mid-morning sun: high enough for bright light, angled enough to be
    // visible in the sky and to give directional shading.
    this.setTimeOfDay(0.38);
  }

  setTimeOfDay(t: number): void {
    this.timeOfDay = t;
    
    // Calculate sun position based on time
    // t = 0 -> midnight, t = 0.25 -> sunrise, t = 0.5 -> noon, t = 0.75 -> sunset
    const angle = (t - 0.25) * Math.PI * 2; // Offset so 0.5 = noon (straight up)
    const sunDist = 1000;
    
    this.sunPosition.set(
      Math.cos(angle) * sunDist,
      Math.sin(angle) * sunDist,
      0
    );
    
    // Adjust sun intensity based on time (brighter at noon)
    const sunHeight = Math.max(0, Math.sin(angle));
    this.material.uniforms.sunIntensity.value = 22 * sunHeight;
    
    // If sun is below horizon, reduce intensity for moon
    if (sunHeight <= 0) {
      this.material.uniforms.sunIntensity.value = 2; // Moon intensity
    }
  }

  getSunPosition(): THREE.Vector3 {
    return this.sunPosition.clone();
  }

  getSunDirection(): THREE.Vector3 {
    return this.sunPosition.clone().normalize();
  }

  setFogColor(color: THREE.Color): void {
    this.material.uniforms.fogColor.value.copy(color);
  }

  /** Painted horizon band — distinct from the seam color so a spec can
   *  glow the low sky without breaking the fog/terrain melt. */
  setHorizonColor(color: THREE.Color): void {
    this.material.uniforms.horizonColor.value.copy(color);
  }

  isDay(): boolean {
    return this.timeOfDay > 0.25 && this.timeOfDay < 0.75;
  }

  followCamera(cameraPosition: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }

  update(_dt: number): void {
    // Optional: auto-advance time
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
