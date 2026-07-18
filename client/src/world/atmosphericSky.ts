import * as THREE from 'three';

// Atmospheric scattering shader based on wwwtyro/glsl-atmosphere
// Rayleigh and Mie scattering for realistic sky colors

const atmosphereVertexShader = /* glsl */`
  varying float vHeight;
  void main() {
    vHeight = normalize(position).y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const atmosphereFragmentShader = /* glsl */`
  varying float vHeight;

  void main() {
    // Simple vertical gradient: horizon haze -> blue zenith
    vec3 horizonColor = vec3(0.7333, 0.8157, 0.9098); // matches FOG_COLOR 0xbbd0e8
    vec3 zenithColor  = vec3(0.18, 0.38, 0.72);

    float t = smoothstep(-0.1, 0.6, vHeight);
    vec3 color = mix(horizonColor, zenithColor, t);

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
    const geometry = new THREE.SphereGeometry(4000, 64, 32);
    
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
