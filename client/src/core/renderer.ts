import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  PIXEL_SCALE,
  TONE_MAPPING_EXPOSURE,
} from './config.js';

export interface RendererSetup {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  contrastPass: ShaderPass;
  isPostProcessingEnabled: () => boolean;
  updateRendererSize: () => void;
  setPixelated: (pixelated: boolean) => void;
  setPostProcessingEnabled: (enabled: boolean) => void;
  resize: (width: number, height: number) => void;
}

export function createRenderer(camera: THREE.PerspectiveCamera, scene: THREE.Scene): RendererSetup {
  let pixelated = localStorage.getItem('fps-pixelated') === 'false' ? false : true;
  let postproEnabled = localStorage.getItem('fps-postpro') === 'false' ? false : true;

  const renderer = new THREE.WebGLRenderer({ antialias: true });

  function getPixelRatio(): number {
    return pixelated ? 1 : Math.min(window.devicePixelRatio, 2);
  }

  function updateRendererSize(): void {
    const width = pixelated
      ? Math.floor(window.innerWidth / PIXEL_SCALE)
      : window.innerWidth;
    const height = pixelated
      ? Math.floor(window.innerHeight / PIXEL_SCALE)
      : window.innerHeight;

    renderer.setSize(width, height);
    renderer.domElement.style.imageRendering = pixelated ? 'pixelated' : 'auto';
    renderer.setPixelRatio(getPixelRatio());
  }

  if (pixelated) {
    renderer.setSize(
      Math.floor(window.innerWidth / PIXEL_SCALE),
      Math.floor(window.innerHeight / PIXEL_SCALE)
    );
    renderer.domElement.style.imageRendering = 'pixelated';
  } else {
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = 'auto';
  }
  renderer.setPixelRatio(getPixelRatio());
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  document.body.appendChild(renderer.domElement);

  // Initialize button text from localStorage
  const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
  pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';

  const postproToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';

  const size = pixelated
    ? new THREE.Vector2(Math.floor(window.innerWidth / PIXEL_SCALE), Math.floor(window.innerHeight / PIXEL_SCALE))
    : new THREE.Vector2(window.innerWidth, window.innerHeight);
  const renderTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
    samples: 4,
  });
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      pixelated ? Math.floor(window.innerWidth / PIXEL_SCALE) : window.innerWidth,
      pixelated ? Math.floor(window.innerHeight / PIXEL_SCALE) : window.innerHeight
    ),
    0.6,
    0.4,
    1
  );
  composer.addPass(bloomPass);

  const contrastPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      contrast: { value: 1.15 },
      brightness: { value: -0.02 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float contrast;
      uniform float brightness;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        color.rgb = (color.rgb - 0.5) * contrast + 0.5 + brightness;
        gl_FragColor = color;
      }
    `
  });
  composer.addPass(contrastPass);

  composer.addPass(new OutputPass());

  bloomPass.enabled = postproEnabled;
  contrastPass.enabled = postproEnabled;

  function setPixelated(enabled: boolean): void {
    pixelated = enabled;
    localStorage.setItem('fps-pixelated', pixelated.toString());
    updateRendererSize();
    const w = pixelated
      ? Math.floor(window.innerWidth / PIXEL_SCALE)
      : window.innerWidth;
    const h = pixelated
      ? Math.floor(window.innerHeight / PIXEL_SCALE)
      : window.innerHeight;
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';
  }

  function setPostProcessingEnabled(enabled: boolean): void {
    postproEnabled = enabled;
    localStorage.setItem('fps-postpro', postproEnabled.toString());
    bloomPass.enabled = postproEnabled;
    contrastPass.enabled = postproEnabled;
    postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  }

  function resize(width: number, height: number): void {
    const w = pixelated
      ? Math.floor(width / PIXEL_SCALE)
      : width;
    const h = pixelated
      ? Math.floor(height / PIXEL_SCALE)
      : height;
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
  }

  // Setup window resize handler
  window.addEventListener('resize', () => {
    updateRendererSize();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    const w = pixelated
      ? Math.floor(window.innerWidth / PIXEL_SCALE)
      : window.innerWidth;
    const h = pixelated
      ? Math.floor(window.innerHeight / PIXEL_SCALE)
      : window.innerHeight;
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
  });

  // Setup button event listeners
  pixelToggleBtn.addEventListener('click', () => {
    setPixelated(!pixelated);
  });

  postproToggleBtn.addEventListener('click', () => {
    setPostProcessingEnabled(!postproEnabled);
  });

  return {
    renderer,
    composer,
    bloomPass,
    contrastPass,
    isPostProcessingEnabled: () => postproEnabled,
    updateRendererSize,
    setPixelated,
    setPostProcessingEnabled,
    resize,
  };
}
