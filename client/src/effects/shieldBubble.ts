// Energy-shield bubble — shared by the local player and remote players.
// Tribes-style read: hexagonal cell lattice + a fresnel rim that glows
// where the surface curves away from the camera, plus a slow scroll so
// the field feels charged rather than static. One ShaderMaterial per
// shielded entity (uniforms are per-instance — the hit ripple is local).

import * as THREE from 'three';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';
import { markProbe } from '../core/fxDiag.js';

// Skinned variant — the field is a shell CLONED from the model's own
// skinned meshes, inflated along the skinned normal. Reads as a contoured
// energy cocoon (medkit-style) instead of a billboarded beach ball, and
// animates with the body for free (clones share the skeleton).
const VERT_SKINNED = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uInflate;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vLocal;
  void main() {
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    transformed += objectNormal * uInflate; // shell thickness off the body
    vLocal = transformed;
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

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

  ${UNGRADE_GLSL}

  void main() {
    vec3 V = normalize(cameraPosition - vPosW);
    float fres = pow(1.0 - abs(dot(V, normalize(vNormalW))), 2.5);

    // Hex cells on the sphere via cube-sphere projection — the normal's
    // dominant axis picks a cube face and the hex grid tiles that face's
    // planar coords. A lat/long mapping (atan + d.y) collapses every
    // meridian at the poles into a pinwheel; cube faces have no poles.
    // Seams on cube edges are the accepted trade of the standard trick.
    vec3 d = normalize(vLocal);
    vec3 ad = abs(d);
    vec2 uv;
    if (ad.x >= ad.y && ad.x >= ad.z) uv = d.zy / ad.x;
    else if (ad.y >= ad.z)             uv = d.xz / ad.y;
    else                               uv = d.xy / ad.z;
    float cell = hexDist(hexCell(uv * 6.0 + uTime * 0.05));
    float hexEdge = smoothstep(0.42, 0.5, cell);

    // Slow energy sweep crawling up the shell.
    float sweep = 0.5 + 0.5 * sin(d.y * 10.0 - uTime * 3.0);

    float a = 0.10 + fres * 0.55 + hexEdge * 0.18 + sweep * 0.05;
    a += uHit * (0.35 + hexEdge * 0.4); // soaked hits flare the lattice
    vec3 col = mix(uColor, vec3(0.85, 0.97, 1.0), fres * 0.6 + uHit * 0.5);
    gl_FragColor = vec4(ungradeColor(col), clamp(a, 0.0, 0.9));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The raw field material — for callers that wrap their own geometry
 *  (viewmodel gun overlay). They own mesh lifecycle + uTime ticking. */
export function makeShieldMaterial(color = 0x3fa8dd): THREE.ShaderMaterial {
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
      uColor: { value: new THREE.Color(color) },
    },
  });
}

export interface ShieldBubble {
  /** Object whose .visible/.position callers drive — a Group facade for
   *  contoured shells (the real clones hang off the model's bones). */
  mesh: THREE.Object3D;
  /** Flash the lattice — call on every absorbed hit. */
  flash(): void;
  update(dt: number): void;
  dispose(): void;
}

export function makeShieldBubble(parent: THREE.Object3D, radius = 2.2, color = 0x3fa8dd): ShieldBubble {
  return makeShieldedMesh(parent, new THREE.SphereGeometry(radius, 32, 20), color);
}

/** Same field, wrapped around arbitrary geometry (the first-person gun).
 *  `parent` is whatever the mesh should be added to — a Scene for world
 *  bubbles, the viewmodel group for the gun overlay. */
export function makeShieldedMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color = 0x3fa8dd): ShieldBubble {
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
      uColor: { value: new THREE.Color(color) },
    },
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.visible = false;
  parent.add(mesh);
  markProbe(mesh, { kind: 'fxMesh', label: 'shieldBubble' });
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

/** Contoured shield — clones every SkinnedMesh under `modelRoot` with the
 *  field material, inflated ~4cm along the skinned normal. The clones
 *  share skeleton/bind so the shell hugs the body through every pose and
 *  inherits the model's scale — no per-frame position updates needed.
 *  Returns null if the model has no skinned meshes yet (not loaded). */
export function makeContouredShield(modelRoot: THREE.Object3D, color = 0x3fa8dd): ShieldBubble | null {
  const sources: THREE.SkinnedMesh[] = [];
  modelRoot.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) sources.push(o as THREE.SkinnedMesh);
  });
  if (sources.length === 0) return null;

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT_SKINNED,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: Math.random() * 100 },
      uHit: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uInflate: { value: 0.04 },
    },
  });

  const clones: THREE.SkinnedMesh[] = [];
  for (const src of sources) {
    const clone = new THREE.SkinnedMesh(src.geometry, mat);
    clone.bind(src.skeleton, src.bindMatrix);
    // Identity child of the source mesh → same world transform; skinned
    // verts can leave the bind-pose bounds, so don't let culling hide it.
    clone.frustumCulled = false;
    clone.visible = false;
    clone.raycast = () => {}; // shield is cosmetic — never eats ray hits
    src.add(clone);
    clones.push(clone);
  }

  // Facade: callers toggle mesh.visible / mesh.position like a scene
  // bubble — here it just fans visibility out to the clones (position is
  // implicit; the shell rides the skeleton).
  const facade = new THREE.Group();
  Object.defineProperty(facade, 'visible', {
    get: () => clones[0]?.visible ?? false,
    set: (v: boolean) => { for (const c of clones) c.visible = v; },
  });

  return {
    mesh: facade,
    flash() { mat.uniforms.uHit.value = 1; },
    update(dt) {
      mat.uniforms.uTime.value += dt;
      mat.uniforms.uHit.value = Math.max(0, mat.uniforms.uHit.value - dt * 4);
    },
    dispose() {
      for (const c of clones) c.parent?.remove(c); // geometry is the model's — not ours to dispose
      mat.dispose();
    },
  };
}
