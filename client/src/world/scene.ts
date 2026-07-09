import * as THREE from 'three';

import {
  FOG_COLOR,
  FOG_DENSITY,
  SKY_TURBIDITY,
  SKY_RAYLEIGH,
  SKY_MIE_COEFFICIENT,
  SKY_MIE_DIRECTIONAL_G,
  SKY_SUN_INTENSITY,
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

export interface SceneSetup {
  scene: THREE.Scene;
  atmosphericSky: AtmosphericSky;
  volumetricClouds: VolumetricClouds;
  ambient: THREE.AmbientLight;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  update: (dt: number) => void;
}

export function createScene(): SceneSetup {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = new THREE.Color(FOG_COLOR);

  // Atmospheric Sky
  const atmosphericSky = new AtmosphericSky(scene, {
    turbidity: SKY_TURBIDITY,
    rayleigh: SKY_RAYLEIGH,
    mieCoefficient: SKY_MIE_COEFFICIENT,
    mieDirectionalG: SKY_MIE_DIRECTIONAL_G,
    sunIntensity: SKY_SUN_INTENSITY,
  });

  // Volumetric Clouds
  const volumetricClouds = new VolumetricClouds(scene, {
    count: CLOUD_COUNT,
    cloudColor: new THREE.Color(0xffffff),
    cloudDensity: CLOUD_DENSITY,
    windSpeed: CLOUD_WIND_SPEED,
    windDirection: new THREE.Vector3(1, 0, 0.1),
    minHeight: CLOUD_MIN_HEIGHT,
    maxHeight: CLOUD_MAX_HEIGHT,
    spreadRadius: CLOUD_SPREAD_RADIUS,
  });

  // Lighting
  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.camera.near = SHADOW_CAMERA_NEAR;
  sun.shadow.camera.far = SHADOW_CAMERA_FAR;
  sun.shadow.camera.left = -SHADOW_CAMERA_SIZE;
  sun.shadow.camera.right = SHADOW_CAMERA_SIZE;
  sun.shadow.camera.top = SHADOW_CAMERA_SIZE;
  sun.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // Sync sun position with atmospheric sky
  sun.position.copy(atmosphericSky.getSunPosition());
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  volumetricClouds.setSunDirection(atmosphericSky.getSunDirection());

  const hemi = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY);
  scene.add(hemi);

  function update(dt: number): void {
    volumetricClouds.update(dt);
    atmosphericSky.update(dt);
    
    // Sync sun position with atmospheric sky (for dynamic day/night)
    sun.position.copy(atmosphericSky.getSunPosition());
    volumetricClouds.setSunDirection(atmosphericSky.getSunDirection());
  }

  return {
    scene,
    atmosphericSky,
    volumetricClouds,
    ambient,
    sun,
    hemi,
    update,
  };
}
