// Gameplay-water surface — one translucent, wave-animated plane at the
// map's sea level. The lit seafloor (coast terrain preset) shows through it,
// so shallow/deep reads come from the terrain below while this layer adds
// ripple normals, a grazing-angle haze mirror, and a sun glint. Fog is
// blended with three's own chunks so the water dissolves into the horizon
// seams identically to the terrain. Absent `water` removes the plane.
//
// A map with no `water` block never builds this, so every dry map renders
// exactly as before.

import * as THREE from 'three';
import type { WaterSpec } from '../../../shared/mapSpec.js';
import { getWorldScale } from './heightmap.js';

/** Authored defaults — used when the spec gives only a level. */
const DEFAULT_SHALLOW: [number, number, number] = [0.1, 0.34, 0.4];
const DEFAULT_DEEP: [number, number, number] = [0.02, 0.1, 0.2];

const VERT = /* glsl */`
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vWorld;
#include <fog_pars_fragment>

// Surface gradient of a few summed directional sines (world-anchored).
vec2 ripple(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(0.85, 0.53));
  g += d1 * (0.05 * 0.16 * cos(dot(p, d1) * 0.16 + t * 1.1));
  vec2 d2 = normalize(vec2(-0.42, 0.91));
  g += d2 * (0.035 * 0.27 * cos(dot(p, d2) * 0.27 + t * 1.6));
  vec2 d3 = normalize(vec2(0.31, -0.95));
  g += d3 * (0.02 * 0.55 * cos(dot(p, d3) * 0.55 + t * 2.3));
  return g;
}

void main() {
  vec2 g = ripple(vWorld.xz, uTime);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 view = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(n, view), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.0);
  // Base tint walks deep→shallow with view angle; grazing angles mirror the
  // haze so the sea blends into the fog band (same colour the sky seam uses).
  vec3 col = mix(uDeep, uShallow, ndv * 0.6 + 0.25);
  col = mix(col, fogColor, fres * 0.75);
  vec3 h = normalize(view + normalize(uSunDir));
  float spec = pow(max(dot(n, h), 0.0), 160.0);
  col += uSunColor * spec * 0.9;
  float alpha = mix(0.58, 0.95, fres);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

let mesh: THREE.Mesh | null = null;
let material: THREE.ShaderMaterial | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let builtSize = 0;

/** Create, update, or remove the sea surface for `water` (undefined = dry). */
export function applyWaterSurface(scene: THREE.Scene, water?: WaterSpec): void {
  if (!water) {
    if (mesh) {scene.remove(mesh);}
    material?.dispose();
    geometry?.dispose();
    mesh = null; material = null; geometry = null; builtSize = 0;
    return;
  }

  const size = Math.max(getWorldScale() * 2.5, 2000);
  if (!mesh || !material || !geometry || builtSize !== size) {
    if (mesh) {scene.remove(mesh);}
    material?.dispose(); geometry?.dispose();
    geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uShallow: { value: new THREE.Color() },
          uDeep: { value: new THREE.Color() },
          uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.2) },
          uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    // Advance the ripple clock each frame it renders — wall time is fine for
    // a purely visual layer (never feeds the sim).
    mesh.onBeforeRender = (): void => { material!.uniforms.uTime.value = performance.now() * 0.001; };
    scene.add(mesh);
    builtSize = size;
  }

  const shallow = water.color ?? DEFAULT_SHALLOW;
  const deep = water.deep ?? DEFAULT_DEEP;
  (material.uniforms.uShallow.value as THREE.Color).setRGB(shallow[0], shallow[1], shallow[2], THREE.SRGBColorSpace);
  (material.uniforms.uDeep.value as THREE.Color).setRGB(deep[0], deep[1], deep[2], THREE.SRGBColorSpace);
  // Sun rides the sky dome (a dusk atmosphere has already re-aimed it).
  const sky = scene.getObjectByName('__sky')?.userData.sky as { getSunDirection(): THREE.Vector3 } | undefined;
  const dir = sky?.getSunDirection();
  if (dir) {(material.uniforms.uSunDir.value as THREE.Vector3).copy(dir);}
  mesh!.position.y = water.level;
}
