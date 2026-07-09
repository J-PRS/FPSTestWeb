import * as THREE from 'three';

// Atmospheric scattering shader based on wwwtyro/glsl-atmosphere
// Rayleigh and Mie scattering for realistic sky colors

const atmosphereVertexShader = /* glsl */`
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const atmosphereFragmentShader = /* glsl */`
  uniform vec3 sunPosition;
  uniform float sunIntensity;
  uniform float rayleigh; // 3.0
  uniform float mieCoefficient; // 0.005
  uniform float mieDirectionalG; // 0.7
  uniform float turbidity; // 10.0
  
  varying vec3 vWorldPosition;

  const float PI = 3.141592653589793;
  const float n = 1.0003; // refractive index of air
  const float N = 2.545e25; // number of molecules per unit volume
  
  // Rayleigh scattering coefficient
  vec3 rayleighCoeff = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  
  // Mie scattering coefficient
  const float mieCoeff = 21e-6;
  
  // Scale heights
  const float rayleighScale = 8e3;
  const float mieScale = 1.2e3;
  
  // Planet radius
  const float planetRadius = 6371e3;
  const float atmosphereRadius = 6471e3;

  // Ray-sphere intersection
  vec2 rsi(vec3 r0, vec3 rd, float sr) {
    float a = dot(rd, rd);
    float b = 2.0 * dot(rd, r0);
    float c = dot(r0, r0) - (sr * sr);
    float d = (b * b) - 4.0 * a * c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2((-b - d) / (2.0 * a), (-b + d) / (2.0 * a));
  }

  // Phase function for Rayleigh scattering
  float rayleighPhase(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  }

  // Phase function for Mie scattering (Henyey-Greenstein)
  float miePhase(float mu, float g) {
    float gg = g * g;
    float a = (1.0 - gg) / (4.0 * PI * pow(1.0 + gg - 2.0 * g * mu, 1.5));
    return a * (1.0 + gg) / (2.0 * pow(1.0 + gg - 2.0 * g * mu, 1.5));
  }

  vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun, float iSun) {
    // Normalize
    pSun = normalize(pSun);
    r = normalize(r);
    
    // Primary ray intersection with atmosphere
    vec2 p = rsi(r0, r, atmosphereRadius);
    if (p.x > p.y) return vec3(0.0);
    p.y = min(p.y, rsi(r0, r, planetRadius).x);
    
    // Primary ray step size
    float iStepSize = (p.y - p.x) / float(32); // 32 samples for performance
    
    // Primary ray time
    float iTime = 0.0;
    
    // Accumulators
    vec3 totalRlh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    
    // Optical depth accumulators
    float iOdRlh = 0.0;
    float iOdMie = 0.0;
    
    // Primary ray samples
    for (int i = 0; i < 32; i++) {
      vec3 iPos = r0 + r * (iTime + iStepSize * 0.5);
      
      float iHeight = length(iPos) - planetRadius;
      
      // Optical depth for primary ray
      float odStepRlh = exp(-iHeight / rayleighScale) * iStepSize;
      float odStepMie = exp(-iHeight / mieScale) * iStepSize;
      
      iOdRlh += odStepRlh;
      iOdMie += odStepMie;
      
      // Secondary ray (light ray) intersection
      vec2 j = rsi(iPos, pSun, atmosphereRadius);
      float jStepSize = (j.y - j.x) / float(8); // 8 samples for light ray
      
      // Secondary ray time
      float jTime = 0.0;
      
      // Optical depth accumulators for secondary ray
      float jOdRlh = 0.0;
      float jOdMie = 0.0;
      
      // Secondary ray samples
      for (int k = 0; k < 8; k++) {
        vec3 jPos = iPos + pSun * (jTime + jStepSize * 0.5);
        float jHeight = length(jPos) - planetRadius;
        
        jOdRlh += exp(-jHeight / rayleighScale) * jStepSize;
        jOdMie += exp(-jHeight / mieScale) * jStepSize;
        
        jTime += jStepSize;
      }
      
      // Attenuation
      vec3 attn = exp(-(mieCoeff * (iOdMie + jOdMie) + rayleighCoeff * (iOdRlh + jOdRlh)));
      
      // Accumulate scattering
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      
      iTime += iStepSize;
    }
    
    // Phase functions
    float mu = dot(r, pSun);
    float pRlh = rayleighPhase(mu);
    
    // Suppress Mie forward peak to hide the visible sun disc
    float pMie = miePhase(mu, mieDirectionalG) * (1.0 - smoothstep(0.85, 0.99, mu));
    
    // Final color
    return iSun * (pRlh * rayleighCoeff * totalRlh + pMie * mieCoeff * totalMie);
  }

  void main() {
    vec3 direction = normalize(vWorldPosition);
    
    // Simple gradient blue sky - no atmospheric scattering
    vec3 skyColorBottom = vec3(0.4, 0.6, 0.9);
    vec3 skyColorTop = vec3(0.05, 0.15, 0.4);
    
    float height = direction.y;
    vec3 color = mix(skyColorBottom, skyColorTop, clamp(height, 0.0, 1.0));
    
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface AtmosphericSkyParams {
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  sunIntensity?: number;
}

export class AtmosphericSky {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private sunPosition: THREE.Vector3;
  private timeOfDay: number = 0.5; // 0-1, 0.5 = noon

  constructor(scene: THREE.Scene, params: AtmosphericSkyParams = {}) {
    const geometry = new THREE.SphereGeometry(4000, 32, 16);
    
    this.sunPosition = new THREE.Vector3(0, 1, 0);
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        sunPosition: { value: this.sunPosition },
        sunIntensity: { value: params.sunIntensity ?? 22.0 },
        rayleigh: { value: params.rayleigh ?? 3.0 },
        mieCoefficient: { value: params.mieCoefficient ?? 0.005 },
        mieDirectionalG: { value: params.mieDirectionalG ?? 0.7 },
        turbidity: { value: params.turbidity ?? 10.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    
    this.mesh = new THREE.Mesh(geometry, this.material);
    scene.add(this.mesh);
    
    // Set initial time to noon
    this.setTimeOfDay(0.5);
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
    this.material.uniforms.sunIntensity.value = 22.0 * sunHeight;
    
    // If sun is below horizon, reduce intensity for moon
    if (sunHeight <= 0) {
      this.material.uniforms.sunIntensity.value = 2.0; // Moon intensity
    }
  }

  getSunPosition(): THREE.Vector3 {
    return this.sunPosition.clone();
  }

  getSunDirection(): THREE.Vector3 {
    return this.sunPosition.clone().normalize();
  }

  isDay(): boolean {
    return this.timeOfDay > 0.25 && this.timeOfDay < 0.75;
  }

  update(_dt: number): void {
    // Optional: auto-advance time
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
