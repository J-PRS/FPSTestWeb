// Energy-shield bubble — shared by the local player and remote players.
// Tribes-style read: hexagonal cell lattice + a fresnel rim that glows
// where the surface curves away from the camera, plus a slow scroll so
// the field feels charged rather than static. One ShaderMaterial per
// shielded entity (uniforms are per-instance — the hit ripple is local).

import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uHit;      // 1 right after a soaked hit, decays to 0
  uniform vec3 uColor;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vLocal;

  // Pointy-top hex distance on a 2D lattice — drives the cell borders.
  float hexDist(vec2 p) {
    p = abs(p);
    return max(dot(p, normalize(vec2(1.0, 1.73))), p.x);
  }
  vec2 hexCell(vec2 p) {
    vec2 s = vec2(1.0, 1.73);
    vec2 h = s * 0.5;
    vec2 a = mod(p, s) - h;
    vec2 b = mod(p - h, s) - h;
    return dot(a, a) < dot(b, b) ? a : b;
  }

  void main() {
    vec3 V = normalize(cameraPosition - vPosW);
    float fres = pow(1.0 - abs(dot(V, normalize(vNormalW))), 2.5);

    // Hex cells on the sphere via its local normal direction — stable
    // under motion (the pattern rides the bubble, not the screen).
    vec3 d = normalize(vLocal);
    vec2 uv = vec2(atan(d.z, d.x) * 2.0, d.y * 3.0) + uTime * 0.05;
    float cell = hexDist(hexCell(uv * 4.0));
    float hexEdge = smoothstep(0.42, 0.5, cell);

    // Slow energy sweep crawling up the shell.
    float sweep = 0.5 + 0.5 * sin(d.y * 10.0 - uTime * 3.0);

    float a = 0.10 + fres * 0.55 + hexEdge * 0.18 + sweep * 0.05;
    a += uHit * (0.35 + hexEdge * 0.4); // soaked hits flare the lattice
    vec3 col = mix(uColor, vec3(0.85, 0.97, 1.0), fres * 0.6 + uHit * 0.5);
    gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
  }
`;

/** The raw field material — for callers that wrap their own geometry
 *  (viewmodel gun overlay). They own mesh lifecycle + uTime ticking. */
export function makeShieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: Math.random() * 100 },
      uHit: { value: 0 },
      uColor: { value: new THREE.Color(0x3fa8dd) },
    },
  });
}

export interface ShieldBubble {
  mesh: THREE.Mesh;
  /** Flash the lattice — call on every absorbed hit. */
  flash(): void;
  update(dt: number): void;
  dispose(): void;
}

export function makeShieldBubble(parent: THREE.Object3D, radius = 2.2): ShieldBubble {
  return makeShieldedMesh(parent, new THREE.SphereGeometry(radius, 32, 20));
}

/** Same field, wrapped around arbitrary geometry (the first-person gun).
 *  `parent` is whatever the mesh should be added to — a Scene for world
 *  bubbles, the viewmodel group for the gun overlay. */
export function makeShieldedMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry): ShieldBubble {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: Math.random() * 100 }, // desync bubbles on the field
      uHit: { value: 0 },
      uColor: { value: new THREE.Color(0x3fa8dd) },
    },
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.visible = false;
  parent.add(mesh);
  return {
    mesh,
    flash() { mat.uniforms.uHit.value = 1; },
    update(dt) {
      mat.uniforms.uTime.value += dt;
      mat.uniforms.uHit.value = Math.max(0, mat.uniforms.uHit.value - dt * 4);
    },
    dispose() {
      parent.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
