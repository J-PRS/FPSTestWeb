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
  uniform vec3 fogColor;   // linear-space horizon color (matches terrain fog exactly)
  uniform vec3 zenithColor; // linear-space zenith color

  void main() {
    // Flat horizon band: sky is exactly fogColor for vHeight < 0.02,
    // so fully-fogged terrain is invisible against the sky at the horizon.
    // Transition to zenith starts at 0.02 and ends at 0.45.
    float t = smoothstep(0.02, 0.45, vHeight);
    vec3 color = mix(fogColor, zenithColor, t);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface AtmosphericSkyParams {
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  sunIntensity?: number;
  fogColor?: THREE.Color;
  zenithColor?: THREE.Color;
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
        fogColor: { value: params.fogColor ?? new THREE.Color(0xbbd0e8) },
        zenithColor: { value: params.zenithColor ?? new THREE.Color(0x2e6cb8) },
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
