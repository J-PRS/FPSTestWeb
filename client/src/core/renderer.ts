import * as THREE from 'three';
import { settings } from './settings.js';
import {
  Effect,
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  BrightnessContrastEffect,
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
  // Pixel mode: 0 = off, 1 = hard 4x4, 2 = medium 2x2, 3 = xBR-smooth upscale
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
    if (px === 'medium') pixelMode = 2;
    if (px === 'smooth' || px === 'on') pixelMode = 3;
    const pp = qp.get('postpro');
    if (pp === 'off') postproEnabled = false;
    if (pp === 'on') postproEnabled = true;
    const bm = qp.get('bloom');
    if (bm === 'off') bloomEnabled = false;
    if (bm === 'on') bloomEnabled = true;
    // Pixelated is the cheap path: stored bloom/postpro don't re-engage
    // under it (hard mode has no composer at all); URL params may opt in.
    if (pixelMode > 0 && pp === null && bm === null) {
      postproEnabled = false;
      bloomEnabled = false;
    }
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false });

  function getPixelRatio(): number {
    return pixelMode > 0 ? 1 : Math.min(window.devicePixelRatio, 2);
  }

  // Pixel factor by mode: hard = 4x4 blocks, medium = 2x2, smooth renders
  // at the hard scale so the xBR pass has real chunky texels to work with.
  function pixelFactor(): number {
    if (pixelMode === 1) return PIXEL_SCALE;
    if (pixelMode === 2) return PIXEL_SCALE / 2;
    return 1;
  }

  function pixelLabel(): string {
    return pixelMode === 0 ? 'PIXELATION: OFF' : pixelMode === 1 ? 'PIXELATION: HARD'
      : pixelMode === 2 ? 'PIXELATION: MEDIUM' : 'PIXELATION: SMOOTH';
  }

  function updateRendererSize(): void {
    if (pixelMode === 1 || pixelMode === 2) {
      // Hard/medium never touch the composer: render straight into a
      // low-res canvas and let CSS upscale it — colors are identical to
      // direct rendering by construction, and it's the cheapest path.
      const f = pixelFactor();
      renderer.setPixelRatio(1);
      renderer.setSize(Math.floor(window.innerWidth / f),
        Math.floor(window.innerHeight / f), false);
      renderer.domElement.style.imageRendering = 'pixelated';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      return;
    }
    // Canvas stays full-res — in smooth mode only the composer buffers
    // drop to 1/PIXEL_SCALE and the upscale pass reconstructs to screen.
    renderer.setPixelRatio(getPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = 'auto';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
  }

  updateRendererSize();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  document.body.appendChild(renderer.domElement);

  // Initialize button text from localStorage
  const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
  pixelToggleBtn.textContent = pixelLabel();

  const bloomToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
  bloomToggleBtn.textContent = bloomEnabled ? 'BLOOM: ON' : 'BLOOM: OFF';

  const postproToggleBtn = document.getElementById('postpro-toggle')! as HTMLButtonElement;
  postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';

  // Whole-scene bloom gated by a luminance threshold: emitters (trails,
  // explosions, nuggets) push the brightest colors, the lit terrain and sky
  // stay under it, so bloom never washes the frame. (A second composer and
  // SelectiveBloomEffect both proved fragile here — keep the simple one.)
  const bloomEffect = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0.9,
    intensity: 1.5,
    radius: 0.6,
  });

  // xBR-lite upscaler for SMOOTH pixelated mode: the scene renders at
  // 1/PIXEL_SCALE, then flat texel interiors sample nearest (crisp pixels)
  // while detected edges get diagonal-aware blending — xBR philosophy.
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

  const bloomMergePass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomMergePass);

  const contrastPass = new EffectPass(camera, new BrightnessContrastEffect({ contrast: 0.06 }));
  composer.addPass(contrastPass);

  // No composer tone-map pass: ToneMappingEffect can't apply our 0.4
  // exposure, so instead the scene renders WITH renderer ACES+exposure into
  // the buffer — pixelated output stays color-identical to direct render.

  // Pixelated mode: scene renders at 1/PIXEL_SCALE into the composer buffer,
  // then this pass upscales to the full-res canvas with edge-aware blending.
  const upscalePass = new EffectPass(camera, upscaleEffect);
  composer.addPass(upscalePass);

  bloomMergePass.enabled = bloomEnabled;
  contrastPass.enabled = postproEnabled;
  upscalePass.enabled = pixelMode === 3;
  upscaleEffect.uniforms.get('mode')!.value = 1;

  // composer.setSize() also resizes the canvas — so always set buffers first,
  // then restore the canvas to full res. Pixelated = low-res buffers upscaled
  // by the final pass; the canvas itself never shrinks.
  function applyBufferSizes(): void {
    // Composer buffers only shrink for smooth mode — hard/medium bypass it.
    const w = pixelMode === 3 ? Math.floor(window.innerWidth / PIXEL_SCALE) : window.innerWidth;
    const h = pixelMode === 3 ? Math.floor(window.innerHeight / PIXEL_SCALE) : window.innerHeight;
    composer.setSize(w, h);
    upscaleEffect.uniforms.get('lowTexel')!.value.set(1 / w, 1 / h);
    // composer.setSize() also resizes the canvas — restore whichever canvas
    // sizing the active pixel mode wants.
    updateRendererSize();
  }
  applyBufferSizes();

  function render(dt?: number): void {
    composer.render(dt);
  }

  function setPixelated(mode: number): void {
    pixelMode = mode;
    settings.set('fps-pixelated', pixelMode);
    upscalePass.enabled = pixelMode === 3;
    upscaleEffect.uniforms.get('mode')!.value = 1;
    // Pixelated is the cheap/retro path — bloom and contrast post-pro are
    // the opposite of "simple low-res render", so opting in drops them.
    if (pixelMode > 0) {
      if (postproEnabled) setPostProcessingEnabled(false);
      if (bloomEnabled) setBloomEnabled(false);
    }
    updateRendererSize();
    applyBufferSizes();
    pixelToggleBtn.textContent = pixelLabel();
  }

  function setPostProcessingEnabled(enabled: boolean): void {
    // Hard/medium pixelation have no composer — post can't exist there.
    postproEnabled = enabled && (pixelMode === 0 || pixelMode === 3);
    settings.set('fps-postpro', postproEnabled);
    contrastPass.enabled = postproEnabled;
    postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
  }

  function setBloomEnabled(enabled: boolean): void {
    // Bloom needs the composer — hard/medium pixelation have none.
    bloomEnabled = enabled && (pixelMode === 0 || pixelMode === 3);
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
    setPixelated((pixelMode + 1) % 4);
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
    needsComposer: () => pixelMode === 3 || bloomEnabled || postproEnabled,
    isPostProcessingEnabled: () => postproEnabled,
    isBloomEnabled: () => bloomEnabled,
    setBloomEnabled,
    updateRendererSize,
    setPixelated,
    setPostProcessingEnabled,
    resize,
  };
}
