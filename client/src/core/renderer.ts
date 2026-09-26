import * as THREE from 'three';
import { settings } from './settings.js';
import {
  Effect,
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  BrightnessContrastEffect,
  TextureEffect,
  ToneMappingEffect,
  ToneMappingMode,
  BlendFunction,
} from 'postprocessing';
import {
  PIXEL_SCALE,
  TONE_MAPPING_EXPOSURE,
  BLOOM_LAYER,
} from './config.js';

// Mark an object (and its children) as a bloom emitter — only layer-flagged
// objects feed the bloom buffer, so bloom can never touch the base scene.
export function markBloom(root: THREE.Object3D): void {
  root.traverse(o => o.layers.enable(BLOOM_LAYER));
}

export interface RendererSetup {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: EffectPass;
  contrastPass: EffectPass;
  render: (dt?: number) => void;
  needsComposer: () => boolean;
  isPostProcessingEnabled: () => boolean;
  isBloomEnabled: () => boolean;
  setBloomEnabled: (enabled: boolean) => void;
  updateRendererSize: () => void;
  setPixelated: (mode: number) => void;
  setPostProcessingEnabled: (enabled: boolean) => void;
  resize: (width: number, height: number) => void;
}

export function createRenderer(camera: THREE.PerspectiveCamera, scene: THREE.Scene): RendererSetup {
  // Pixel mode: 0 = off, 1 = hard nearest pixels, 2 = edge-aware upscale
  let pixelMode = settings.get('fps-pixelated');
  // All post-processing defaults OFF — the scene reads cleanest raw.
  // Opt in via localStorage or ?postpro=on / ?bloom=on.
  let postproEnabled = settings.get('fps-postpro');
  let bloomEnabled = settings.get('fps-bloom');
  // URL overrides for headless screenshots/testing
  {
    const qp = new URLSearchParams(window.location.search);
    const px = qp.get('pixelated');
    if (px === 'off') pixelMode = 0;
    if (px === 'hard') pixelMode = 1;
    if (px === 'smooth' || px === 'on') pixelMode = 2;
    const pp = qp.get('postpro');
    if (pp === 'off') postproEnabled = false;
    if (pp === 'on') postproEnabled = true;
    const bm = qp.get('bloom');
    if (bm === 'off') bloomEnabled = false;
    if (bm === 'on') bloomEnabled = true;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false });

  function getPixelRatio(): number {
    return pixelMode > 0 ? 1 : Math.min(window.devicePixelRatio, 2);
  }

  function updateRendererSize(): void {
    // Canvas stays full-res — in pixelated mode only the composer buffers
    // drop to 1/PIXEL_SCALE and the upscale pass reconstructs to screen.
    renderer.setPixelRatio(getPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = 'auto';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
  }

  renderer.setPixelRatio(getPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.imageRendering = 'auto';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  document.body.appendChild(renderer.domElement);

  // Initialize button text from localStorage
  const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
  pixelToggleBtn.textContent = pixelMode === 0 ? 'PIXELATED: OFF' : pixelMode === 1 ? 'PIXELATED: HARD' : 'PIXELATED: SMOOTH';

  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  bloomToggleBtn.textContent = bloomEnabled ? 'BLOOM: ON' : 'BLOOM: OFF';

  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';

  // Selective bloom: a second composer renders ONLY objects flagged with
  // BLOOM_LAYER into an HDR buffer, blurs it, and the main composer adds the
  // result over the untouched scene. Base-scene pixels can never wash out.
  const bloomCamera = camera.clone() as THREE.PerspectiveCamera;
  bloomCamera.layers.set(BLOOM_LAYER);

  const bloomComposer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  const bloomRenderPass = new RenderPass(scene, bloomCamera);
  bloomRenderPass.ignoreBackground = true;
  bloomRenderPass.clearPass.overrideClearColor = new THREE.Color(0, 0, 0);
  bloomRenderPass.clearPass.overrideClearAlpha = 1;
  bloomComposer.addPass(bloomRenderPass);
  bloomComposer.addPass(new EffectPass(bloomCamera, new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0,   // buffer contains only emitters — everything glows
    intensity: 1.5,
    radius: 0.6,
  })));
  // Keep the bloom result in the buffer, not on screen.
  bloomComposer.passes[bloomComposer.passes.length - 1].renderToScreen = false;

  // Edge-aware upscaler for pixelated mode: flat texel interiors sample
  // nearest (crisp pixels), detected edges get diagonal-aware blending.
  const upscaleEffect = new Effect('EdgeUpscale', /* glsl */ `
    uniform vec2 lowTexel; // 1/low-res-buffer size
    uniform float mode;  // 0 = nearest (hard pixels), 1 = edge-aware
    float cdist(vec3 a, vec3 b) {
      vec3 d = a - b;
      return dot(d, d);
    }
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec2 inv = lowTexel;
      vec2 pos = uv / inv - 0.5;
      vec2 i = floor(pos);
      vec2 f = fract(pos);

      vec3 c00 = texture2D(inputBuffer, (i + vec2(0.5, 0.5)) * inv).rgb;

      if (mode < 0.5) {
        outputColor = vec4(c00, 1.0);
        return;
      }

      vec3 c10 = texture2D(inputBuffer, (i + vec2(1.5, 0.5)) * inv).rgb;
      vec3 c01 = texture2D(inputBuffer, (i + vec2(0.5, 1.5)) * inv).rgb;
      vec3 c11 = texture2D(inputBuffer, (i + vec2(1.5, 1.5)) * inv).rgb;

      float d0 = cdist(c00, c11); // main-diagonal coherence
      float d1 = cdist(c01, c10); // anti-diagonal coherence
      float e  = max(max(cdist(c00, c10), cdist(c00, c01)),
                     max(cdist(c10, c11), cdist(c01, c11)));

      if (e < 0.002) {
        // flat — hard pixel (nearest)
        vec3 c = f.x < 0.5 ? (f.y < 0.5 ? c00 : c01) : (f.y < 0.5 ? c10 : c11);
        outputColor = vec4(c, 1.0);
      } else if (d0 + 0.005 < d1) {
        // main diagonal edge
        float t = clamp((f.x + f.y - 1.0) * 2.0 + 0.5, 0.0, 1.0);
        outputColor = vec4(mix(c00, c11, t), 1.0);
      } else if (d1 + 0.005 < d0) {
        // anti diagonal edge
        float t = clamp((f.y - f.x) * 2.0 + 0.5, 0.0, 1.0);
        outputColor = vec4(mix(c10, c01, t), 1.0);
      } else {
        // cardinal edge — directional blend along the edge axis
        float ex = cdist(c00, c10) + cdist(c01, c11); // vertical edge strength
        float ey = cdist(c00, c01) + cdist(c10, c11); // horizontal edge strength
        float fx = ex > ey * 1.5 ? floor(f.x + 0.5) : f.x;
        float fy = ey > ex * 1.5 ? floor(f.y + 0.5) : f.y;
        outputColor = vec4(mix(mix(c00, c10, fx), mix(c01, c11, fx), fy), 1.0);
      }
    }
  `, {
    blendFunction: BlendFunction.NORMAL,
    uniforms: new Map<string, THREE.Uniform>([
      ['lowTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
      ['mode', new THREE.Uniform(1)],
    ]),
  });

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  composer.addPass(new RenderPass(scene, camera));

  const bloomTextureEffect = new TextureEffect({
    texture: bloomComposer.inputBuffer.texture,
    blendFunction: BlendFunction.ADD,
  });
  const bloomMergePass = new EffectPass(camera, bloomTextureEffect);
  composer.addPass(bloomMergePass);

  const contrastPass = new EffectPass(camera, new BrightnessContrastEffect({ contrast: 0.06 }));
  composer.addPass(contrastPass);

  // ACES tone map so composer output matches direct rendering
  composer.addPass(new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));

  // Pixelated mode: scene renders at 1/PIXEL_SCALE into the composer buffer,
  // then this pass upscales to the full-res canvas with edge-aware blending.
  const upscalePass = new EffectPass(camera, upscaleEffect);
  composer.addPass(upscalePass);

  bloomMergePass.enabled = bloomEnabled;
  contrastPass.enabled = postproEnabled;
  upscalePass.enabled = pixelMode > 0;
  upscaleEffect.uniforms.get('mode')!.value = pixelMode === 2 ? 1 : 0;

  // composer.setSize() also resizes the canvas — so always set buffers first,
  // then restore the canvas to full res. Pixelated = low-res buffers upscaled
  // by the final pass; the canvas itself never shrinks.
  function applyBufferSizes(): void {
    const w = pixelMode > 0 ? Math.floor(window.innerWidth / PIXEL_SCALE) : window.innerWidth;
    const h = pixelMode > 0 ? Math.floor(window.innerHeight / PIXEL_SCALE) : window.innerHeight;
    composer.setSize(w, h);
    bloomComposer.setSize(w, h);
    upscaleEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    renderer.setPixelRatio(getPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
  }
  applyBufferSizes();

  function render(dt?: number): void {
    // Tone map is applied by the composer's ToneMappingEffect — the renderer's
    // own tone mapping must be off while the scene renders into buffers, or
    // ACES gets applied twice. Restore ACES afterwards so direct passes that
    // run after this (e.g. the viewmodel overlay) stay tone-mapped.
    renderer.toneMapping = THREE.NoToneMapping;
    if (bloomEnabled) {
      bloomCamera.projectionMatrix.copy(camera.projectionMatrix);
      bloomCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      bloomCamera.position.copy(camera.position);
      bloomCamera.quaternion.copy(camera.quaternion);
      bloomComposer.render(dt);
      // composer's internal buffers ping-pong each frame — rebind the texture
      // that actually holds the bloom result
      bloomTextureEffect.uniforms.get('map')!.value = bloomComposer.inputBuffer.texture;
    }
    composer.render(dt);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  function setPixelated(mode: number): void {
    pixelMode = mode;
    settings.set('fps-pixelated', pixelMode);
    upscalePass.enabled = pixelMode > 0;
    upscaleEffect.uniforms.get('mode')!.value = pixelMode === 2 ? 1 : 0;
    updateRendererSize();
    applyBufferSizes();
    pixelToggleBtn.textContent = pixelMode === 0 ? 'PIXELATED: OFF' : pixelMode === 1 ? 'PIXELATED: HARD' : 'PIXELATED: SMOOTH';
  }

  function setPostProcessingEnabled(enabled: boolean): void {
    postproEnabled = enabled;
    settings.set('fps-postpro', postproEnabled);
    contrastPass.enabled = postproEnabled;
    postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  }

  function setBloomEnabled(enabled: boolean): void {
    bloomEnabled = enabled;
    settings.set('fps-bloom', bloomEnabled);
    bloomMergePass.enabled = bloomEnabled;
    bloomToggleBtn.textContent = bloomEnabled ? 'BLOOM: ON' : 'BLOOM: OFF';
  }

  function resize(_width: number, _height: number): void {
    applyBufferSizes();
  }

  // Setup window resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyBufferSizes();
  });

  // Setup button event listeners
  pixelToggleBtn.addEventListener('click', () => {
    setPixelated((pixelMode + 1) % 3);
  });

  bloomToggleBtn.addEventListener('click', () => {
    setBloomEnabled(!bloomEnabled);
  });

  postproToggleBtn.addEventListener('click', () => {
    setPostProcessingEnabled(!postproEnabled);
  });

  return {
    renderer,
    composer,
    bloomPass: bloomMergePass,
    contrastPass,
    render,
    needsComposer: () => pixelMode > 0 || bloomEnabled || postproEnabled,
    isPostProcessingEnabled: () => postproEnabled,
    isBloomEnabled: () => bloomEnabled,
    setBloomEnabled,
    updateRendererSize,
    setPixelated,
    setPostProcessingEnabled,
    resize,
  };
}
