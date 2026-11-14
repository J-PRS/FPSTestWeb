import * as THREE from 'three';

import {
  FOG_COLOR,
  FOG_START,
  FOG_END,
  SKY_TURBIDITY,
  SKY_RAYLEIGH,
  SKY_MIE_COEFFICIENT,
  SKY_MIE_DIRECTIONAL_G,
  SKY_RAYLEIGH_DIRECTIONAL,
  SKY_SUN_INTENSITY,
  CLOUDS_ENABLED,
  CLOUD_COUNT,
  CLOUD_DENSITY,
  CLOUD_WIND_SPEED,
  CLOUD_MIN_HEIGHT,
  CLOUD_MAX_HEIGHT,
  CLOUD_SPREAD_RADIUS,
  AMBIENT_COLOR,
  AMBIENT_INTENSITY,
  SUN_COLOR,
  SUN_INTENSITY,
  SHADOW_MAP_SIZE,
  SHADOW_CAMERA_NEAR,
  SHADOW_CAMERA_FAR,
  SHADOW_CAMERA_SIZE,
  HEMI_SKY_COLOR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
} from '../core/config.js';

import { AtmosphericSky } from './atmosphericSky.js';
import { VolumetricClouds } from './volumetricClouds.js';
import { SunShafts } from './sunShafts.js';
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

export interface SceneSetup {
  scene: THREE.Scene;
  atmosphericSky: AtmosphericSky;
  volumetricClouds: VolumetricClouds | null;
  sunShafts: SunShafts | null;
  ambient: THREE.AmbientLight;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  update: (dt: number) => void;
  updateCamera: (camera: THREE.Camera) => void;
}

export function createScene(): SceneSetup {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_START, FOG_END);
  scene.background = new THREE.Color(FOG_COLOR);

  // Atmospheric Sky
  const atmosphericSky = new AtmosphericSky(scene, {
    turbidity: SKY_TURBIDITY,
    rayleigh: SKY_RAYLEIGH,
    mieCoefficient: SKY_MIE_COEFFICIENT,
    mieDirectionalG: SKY_MIE_DIRECTIONAL_G,
    rayleighDirectional: SKY_RAYLEIGH_DIRECTIONAL,
    sunIntensity: SKY_SUN_INTENSITY,
    fogColor: new THREE.Color(FOG_COLOR),
  });

  // Fake god-ray glare sprite — off by default (blob glare read wrong);
  // ?shafts=on brings it back. SunShafts itself stays in the codebase.
  const sunShafts = urlParams.get('shafts') === 'on' ? new SunShafts(scene) : null;

  const volumetricClouds = (CLOUDS_ENABLED || urlParams.get('clouds') === 'on')
    ? new VolumetricClouds(scene, {
        count: CLOUD_COUNT,
        cloudColor: new THREE.Color(0xFF_FF_FF),
        cloudDensity: CLOUD_DENSITY,
        windSpeed: CLOUD_WIND_SPEED,
        windDirection: new THREE.Vector3(1, 0, 0.1),
        minHeight: CLOUD_MIN_HEIGHT,
        maxHeight: CLOUD_MAX_HEIGHT,
        spreadRadius: CLOUD_SPREAD_RADIUS,
      })
    : null;

  // Lighting
  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
  scene.add(ambient);

  // Shadow pass is the heaviest per-frame cost on weak GPUs — the whole
  // scene rasterizes a second time into the map. Cheap-path opt-out:
  // ?shadows=off or the fps-shadows setting. Casting stays on in code so
  // renderer.shadowMap.enabled can still gate the raster.
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.castShadow = urlParams.get('shadows') !== 'off' && settings.get('fps-shadows');
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.camera.near = SHADOW_CAMERA_NEAR;
  sun.shadow.camera.far = SHADOW_CAMERA_FAR;
  sun.shadow.camera.left = -SHADOW_CAMERA_SIZE;
  sun.shadow.camera.right = SHADOW_CAMERA_SIZE;
  sun.shadow.camera.top = SHADOW_CAMERA_SIZE;
  sun.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
  // Texel size is ~0.4m at the player-follow frustum — the bias has to
  // cover at least that, or slopes self-shadow into contour-band acne.
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  // Sync sun position with atmospheric sky
  sun.position.copy(atmosphericSky.getSunPosition());
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  volumetricClouds?.setSunDirection(atmosphericSky.getSunDirection());

  const hemi = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY);
  scene.add(hemi);

  function update(dt: number): void {
    volumetricClouds?.update(dt);
    atmosphericSky.update(dt);

    // Sync sun position with atmospheric sky (for dynamic day/night)
    sun.position.copy(atmosphericSky.getSunPosition());
    volumetricClouds?.setSunDirection(atmosphericSky.getSunDirection());
  }

  /** Camera-dependent mood pass — the shader knows where the sun is. */
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  function updateCamera(camera: THREE.Camera): void {
    sunShafts?.update(camera, atmosphericSky.getSunPosition());
    // Shadow frustum follows the viewer: a map-wide 2.4km ortho box only
    // has ~1.2m/texel — every slope acnes — and stops covering off-center
    // play entirely. Snap must happen in LIGHT space on texel
    // boundaries: world-axis snapping still slides the texel grid under
    // the sun's projection, which repaints shadow acne across slopes as
    // the viewer translates (Stable CSM / texel-grid snapping).
    const c = camera.position;
    _fwd.copy(atmosphericSky.getSunDirection()).negate(); // light travel dir
    _right.crossVectors(_fwd, WORLD_UP).normalize();
    _up.crossVectors(_right, _fwd).normalize();
    const texel = (SHADOW_CAMERA_SIZE * 2) / SHADOW_MAP_SIZE;
    const lx = Math.round(c.dot(_right) / texel) * texel;
    const ly = Math.round(c.dot(_up) / texel) * texel;
    const lz = c.dot(_fwd);
    sun.target.position.set(
      _right.x * lx + _up.x * ly + _fwd.x * lz,
      _right.y * lx + _up.y * ly + _fwd.y * lz,
      _right.z * lx + _up.z * ly + _fwd.z * lz);
    sun.target.updateMatrixWorld();
    sun.position.copy(atmosphericSky.getSunPosition()).add(sun.target.position);
  }

  return {
    scene,
    atmosphericSky,
    volumetricClouds,
    sunShafts,
    ambient,
    sun,
    hemi,
    update,
    updateCamera,
  };
}
