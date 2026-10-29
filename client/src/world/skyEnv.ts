// skyEnv — bake the map's own sky into scene.environment so metal and
// rough surfaces pick up real reflections instead of a void. PMREM of a
// mini-scene: the live sky dome (shares its material — the current
// atmosphere uniforms ride along) + a fog-colored ground disc so the
// env's lower hemisphere is terrain-bounce, not black.
//
// Rebakes on every applyAtmosphere call whose (spec, fog) actually
// changed — reconnects/room hops dedupe to zero cost. Cost per bake:
// one 6-face 256px scene raster + mip chain, ~1-3ms, off the hot path.

import * as THREE from 'three';

let pmrem: THREE.PMREMGenerator | null = null;
let rt: THREE.WebGLRenderTarget | null = null;
let lastKey = '';

/** Renderer is registered by gameLoop as window.__renderer — lazily
 *  grabbed so this module never couples into the boot graph. */
function getRenderer(): THREE.WebGLRenderer | undefined {
  return (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer;
}

/** Bake the current sky + fog state into scene.environment. `atmoKey`
 *  is whatever string/fingerprint the caller derives — empty = 'boot'. */
export function bakeSkyEnv(scene: THREE.Scene, atmoKey: string): void {
  const renderer = getRenderer();
  const skyMesh = scene.getObjectByName('__sky') as THREE.Mesh | undefined;
  if (!renderer || !skyMesh) {return;}
  const fog = scene.fog;
  const key = `${atmoKey}|${fog instanceof THREE.Fog ? fog.color.getHexString() : ''}`;
  if (key === lastKey) {return;}
  lastKey = key;

  pmrem ??= new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  // Share the live dome's geometry + material — the atmosphere uniforms
  // the map just wrote are what gets captured.
  envScene.add(new THREE.Mesh(skyMesh.geometry, skyMesh.material));
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2000, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: fog instanceof THREE.Fog ? fog.color : new THREE.Color(0x66_77_88),
    }),
  );
  ground.position.y = -1;
  envScene.add(ground);

  const next = pmrem.fromScene(envScene, 0.04);
  rt?.dispose();
  rt = next;
  scene.environment = rt.texture;
  // Conservative intensity — ambient+hemi+sun already fill the scene;
  // the env's job is specular sheen and metal depth, not more diffuse.
  scene.environmentIntensity = 0.65;
  ground.geometry.dispose();
  ground.material.dispose();
}
