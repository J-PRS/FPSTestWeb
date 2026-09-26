import * as THREE from 'three';

import { ViewModel } from '../entities/ViewModel.js';

export interface ViewModelSetup {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  viewModel: ViewModel;
}

// The viewmodel renders in its own scene+pass with a fixed FOV — the standard
// FPS technique so the gun never stretches at high world FOV and never clips
// into walls. aspect follows the main camera's.
export function createViewModelScene(aspect: number): ViewModelSetup {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, aspect, 0.01, 10);
  scene.add(new THREE.AmbientLight(0x8899aa, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(0.5, 1, 0.4);
  scene.add(sun);
  scene.add(camera); // required so camera-attached viewmodel renders
  return { scene, camera, viewModel: new ViewModel(camera) };
}
