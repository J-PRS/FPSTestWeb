import * as THREE from 'three';

import {
  CLOUD_COUNT, CLOUD_WIND_SPEED, CLOUD_DENSITY,
  CLOUD_SPHERES_PER_CLOUD, CLOUD_DEFAULT_MIN_HEIGHT, CLOUD_DEFAULT_MAX_HEIGHT,
  CLOUD_DEFAULT_SPREAD_RADIUS, CLOUD_WIND_OFFSET_RANGE,
  CLOUD_POSITION_RANGE_XZ, CLOUD_POSITION_RANGE_Y,
  CLOUD_SCALE_MIN, CLOUD_SCALE_RANGE
} from '../core/config.js';

// Cloud shader for soft volumetric appearance
const cloudVertexShader = /* glsl */`
  attribute float windOffset;   // per-instance phase so clusters don't move in lockstep
  uniform vec3 windVector;      // windDirection * windSpeed * time — one uniform, GPU moves every puff
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;

  void main() {
    // Baked instance transform, then wind drift in shader — the CPU
    // touches nothing per frame.
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    wp.xyz += windVector * (1.0 + windOffset);
    const float SPREAD = 3000.0;
    wp.x = mod(wp.x + SPREAD, SPREAD * 2.0) - SPREAD;
    wp.z = mod(wp.z + SPREAD, SPREAD * 2.0) - SPREAD;
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(instanceMatrix) * normal);
    vec4 mvPosition = viewMatrix * wp;
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const cloudFragmentShader = /* glsl */`
  uniform vec3 cloudColor;
  uniform vec3 sunDirection;
  uniform float density;
  
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;
  
  void main() {
    // Fresnel effect for soft edges
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 3.0);
    
    // Lighting
    float light = max(0.0, dot(vNormal, sunDirection)) * 0.5 + 0.5;
    
    // Darker undersides — the single biggest cue that reads "volume"
    // instead of "white spheres".
    float base = mix(0.45, 1.0, smoothstep(-1.0, 0.7, vWorldNormal.y));
    
    // Combine
    vec3 color = cloudColor * light * base;
    float alpha = density * (0.3 + fresnel * 0.7);
    
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface CloudParams {
  count?: number;
  cloudColor?: THREE.Color;
  cloudDensity?: number;
  windSpeed?: number;
  windDirection?: THREE.Vector3;
  minHeight?: number;
  maxHeight?: number;
  spreadRadius?: number;
}

export class VolumetricClouds {
  private mesh: THREE.InstancedMesh;
  private material: THREE.ShaderMaterial;
  private time: number = 0;
  private windDirection: THREE.Vector3;
  private windSpeed: number;
  private sunDirection: THREE.Vector3;
  private dummy: THREE.Object3D;
  private count: number;
  
  constructor(scene: THREE.Scene, params: CloudParams = {}) {
    this.count = params.count ?? CLOUD_COUNT; // Fewer but larger cloud clusters
    this.windDirection = params.windDirection ?? new THREE.Vector3(1, 0, 0.2);
    this.windSpeed = params.windSpeed ?? CLOUD_WIND_SPEED;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.dummy = new THREE.Object3D();

    // Create soft sphere geometry for cloud puffs
    const geometry = new THREE.IcosahedronGeometry(1, 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        cloudColor: { value: params.cloudColor ?? new THREE.Color(0xffffff) },
        sunDirection: { value: this.sunDirection },
        density: { value: params.cloudDensity ?? CLOUD_DENSITY },
        windVector: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.count * CLOUD_SPHERES_PER_CLOUD);
    const windOffsets = new Float32Array(this.mesh.count);
    
    // Generate cloud clusters
    this.generateCloudClusters(params, windOffsets);
    
    scene.add(this.mesh);
  }
  
  private generateCloudClusters(params: CloudParams, windOffsets: Float32Array): void {
    const cloudCount = this.count;
    const spheresPerCloud = CLOUD_SPHERES_PER_CLOUD;
    const minHeight = params.minHeight ?? CLOUD_DEFAULT_MIN_HEIGHT;
    const maxHeight = params.maxHeight ?? CLOUD_DEFAULT_MAX_HEIGHT;
    const spreadRadius = params.spreadRadius ?? CLOUD_DEFAULT_SPREAD_RADIUS;
    
    let instanceIndex = 0;
    
    for (let c = 0; c < cloudCount; c++) {
      // Cloud center position
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * spreadRadius;
      const cx = Math.cos(angle) * radius;
      const cz = Math.sin(angle) * radius;
      const cy = minHeight + Math.random() * (maxHeight - minHeight);
      
      const cloudCenter = new THREE.Vector3(cx, cy, cz);
      const windOffset = Math.random() * CLOUD_WIND_OFFSET_RANGE;
      
      // Generate spheres for this cloud cluster
      for (let s = 0; s < spheresPerCloud; s++) {
        // Random offset from cloud center
        const offset = new THREE.Vector3(
          (Math.random() - 0.5) * CLOUD_POSITION_RANGE_XZ,
          (Math.random() - 0.5) * CLOUD_POSITION_RANGE_Y,
          (Math.random() - 0.5) * CLOUD_POSITION_RANGE_XZ
        );
        
        // Random scale for each sphere
        const scale = CLOUD_SCALE_MIN + Math.random() * CLOUD_SCALE_RANGE;
        
        // Set instance matrix
        this.dummy.position.copy(cloudCenter).add(offset);
        this.dummy.rotation.set(
          Math.random() * Math.PI,
          Math.random() * Math.PI,
          Math.random() * Math.PI
        );
        this.dummy.scale.set(scale, scale, scale);
        this.dummy.updateMatrix();
        
        this.mesh.setMatrixAt(instanceIndex, this.dummy.matrix);
        
        windOffsets[instanceIndex] = windOffset;
        instanceIndex++;
      }
    }
    
    this.mesh.geometry.setAttribute('windOffset', new THREE.InstancedBufferAttribute(windOffsets, 1));
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  
  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction);
    this.material.uniforms.sunDirection.value.copy(direction);
  }
  
  setCloudColor(color: THREE.Color): void {
    this.material.uniforms.cloudColor.value.copy(color);
  }
  
  update(dt: number): void {
    this.time += dt;
    // Wind lives in the vertex shader — one uniform upload per frame,
    // zero per-instance matrix churn or allocation.
    this.material.uniforms.windVector!.value.copy(this.windDirection).multiplyScalar(this.time * this.windSpeed);
  }
  
  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
