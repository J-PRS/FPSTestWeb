import * as THREE from 'three';

const vertShader = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragShader = /* glsl */`
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  varying vec3 vWorldPos;

  void main() {
    float h = normalize(vWorldPos).y; // -1 to 1
    // Remap so horizon color starts at h=-0.15 and transitions upward
    float t = clamp((h + 0.15) / 0.7, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t); // smoothstep - natural S-curve
    vec3 col = mix(horizonColor, topColor, t);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createSkyDome(scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(4000, 16, 8);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertShader,
    fragmentShader: fragShader,
    uniforms: {
      topColor:     { value: new THREE.Color(0x1a3a7a) },
      horizonColor: { value: new THREE.Color(0x88bbdd) }, // exact match to fog color
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  scene.add(dome);
}
