import * as THREE from 'three';

// Nugget/beam halo billboards: one InstancedMesh of camera-facing quads
// serves every live glow — a Sprite per pickup was a draw + a material
// each (the Sprite×24 census class). Per-instance center/size/alpha/color
// ride instanced attributes; the vertex shader billboards by taking the
// view matrix's right/up axes, so a single PlaneGeometry quad turns to
// face the camera the same way SpriteMaterial does — minus the draws.
const CAP = 256;
const VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    vColor = aColor;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 world = aCenter + (right * (position.x) + up * (position.y)) * aSize;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(map, vUv);
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
    if (gl_FragColor.a < 0.003) {discard;}
  }
`;

export class GlowBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly free: number[] = [];
  private readonly centers: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly colors: Float32Array;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(scene: THREE.Scene, map: THREE.Texture) {
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.centers = new Float32Array(CAP * 3);
    this.sizes = new Float32Array(CAP);
    this.alphas = new Float32Array(CAP);
    this.colors = new Float32Array(CAP * 3).fill(1);
    this.geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(this.centers, 3));
    this.geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(this.sizes, 1));
    this.geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.alphas, 1));
    this.geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.colors, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { map: { value: map } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, mat, CAP);
    this.mesh.frustumCulled = false;
    this.mesh.count = CAP;
    scene.add(this.mesh);
    for (let i = CAP - 1; i >= 0; i -= 1) { this.free.push(i); }
  }

  take(): number { return this.free.pop() ?? -1; }

  write(slot: number, x: number, y: number, z: number, size: number, alpha: number, r: number, g: number, b: number): void {
    if (slot < 0) {return;}
    this.centers[slot * 3] = x; this.centers[slot * 3 + 1] = y; this.centers[slot * 3 + 2] = z;
    this.sizes[slot] = size; this.alphas[slot] = alpha;
    this.colors[slot * 3] = r; this.colors[slot * 3 + 1] = g; this.colors[slot * 3 + 2] = b;
    (this.geo.getAttribute('aCenter') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  release(slot: number): void {
    if (slot < 0) {return;}
    this.alphas[slot] = 0;
    (this.geo.getAttribute('aAlpha') as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.free.push(slot);
  }
}
