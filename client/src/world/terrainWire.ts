import * as THREE from 'three';
import { terrainVert } from './terrainShaders.js';
import { urlParams } from '../core/params.js';

// F1 'wire solid' occluder frag - depth-only clone of the displaced
// surface. Same visibility cuts as the wire frag or a coarse ring's
// occluder would hide the finer level's wires living in its hole.
const TERRAIN_OCCL_FRAG = /* glsl */`
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;
  uniform float innerHalfSize;
  uniform vec2 innerGridOrigin;
  uniform float edgeHalf;
  void main() {
    if (innerHalfSize > 0.0) {
      vec2 d = abs(vWorldPos.xz - innerGridOrigin);
      if (max(d.x, d.y) < innerHalfSize) discard;
    }
    if (edgeHalf > 0.5 &&
        length(vWorldPos - vCameraPos) > edgeHalf * 0.55) discard;
    gl_FragColor = vec4(0.0);
  }
`;

/** Occluded-wireframe occluder: the same displaced surface drawn into
 *  depth with color writes off, so back-side palette wires fail depth
 *  when the fill is swapped to wireframe. FLAT positive polygonOffset -
 *  glPolygonOffset only affects fill rasterization, so wireframe lines
 *  all render at effective offset 0; any occluder offset < its own
 *  level's wires eats front edges. */
export function mkTerrainOccluder(geo: THREE.BufferGeometry, uniforms: Record<string, THREE.IUniform>): THREE.Mesh {
  const occlMat = new THREE.ShaderMaterial({
    vertexShader: terrainVert,
    fragmentShader: TERRAIN_OCCL_FRAG,
    uniforms: uniforms as THREE.ShaderMaterial['uniforms'],
    colorWrite: false, depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  // ?occlviz - paint the occluder magenta to verify it rasterizes.
  if (urlParams.has('occlviz')) {
    occlMat.colorWrite = true;
    occlMat.fragmentShader = 'void main(){ gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); }';
  }
  const occl = new THREE.Mesh(geo, occlMat);
  occl.visible = false;
  occl.frustumCulled = false;
  occl.matrixAutoUpdate = false;
  occl.matrixWorldAutoUpdate = false;
  occl.updateMatrixWorld(true);
  return occl;
}
