import * as BABYLON from '@babylonjs/core';

export function createHeightmapTexture(size: number = 256): { dataUrl: string; heightmapData: Float32Array } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  if (!ctx) return { dataUrl: '', heightmapData: new Float32Array(0) };

  const imageData = ctx.createImageData(size, size);
  const heightmapData = new Float32Array(size * size);
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      
      const nx = x / size - 0.5;
      const ny = y / size - 0.5;
      
      let height = 0;
      height += Math.sin(nx * 10) * Math.cos(ny * 10) * 50;
      height += Math.sin(nx * 20 + ny * 15) * 30;
      height += Math.cos(nx * 15 - ny * 20) * 20;
      height += Math.random() * 10;
      
      height = (height + 100) / 200;
      height = Math.max(0, Math.min(255, height * 255));
      
      imageData.data[i] = height;
      imageData.data[i + 1] = height;
      imageData.data[i + 2] = height;
      imageData.data[i + 3] = 255;
      
      heightmapData[y * size + x] = height / 255;
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  return { dataUrl: canvas.toDataURL(), heightmapData };
}

export function getTerrainHeight(
  heightmapData: Float32Array,
  x: number,
  z: number,
  terrainWidth: number = 500,
  terrainHeight: number = 500,
  minHeight: number = 0,
  maxHeight: number = 30
): number {
  const size = 256;
  
  const hmX = (x + terrainWidth / 2) / terrainWidth * size;
  const hmZ = (z + terrainHeight / 2) / terrainHeight * size;
  
  const clampedX = Math.max(0, Math.min(size - 1.001, hmX));
  const clampedZ = Math.max(0, Math.min(size - 1.001, hmZ));
  
  const x0 = Math.floor(clampedX);
  const z0 = Math.floor(clampedZ);
  const x1 = Math.min(size - 1, x0 + 1);
  const z1 = Math.min(size - 1, z0 + 1);
  
  const fx = clampedX - x0;
  const fz = clampedZ - z0;
  
  const h00 = heightmapData[z0 * size + x0];
  const h10 = heightmapData[z0 * size + x1];
  const h01 = heightmapData[z1 * size + x0];
  const h11 = heightmapData[z1 * size + x1];
  
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  const height = h0 * (1 - fz) + h1 * fz;
  
  // The heightmap data is 0-1, but Babylon's CreateGroundFromHeightMap
  // seems to interpret it differently. Scale down to match actual mesh.
  return minHeight + height * (maxHeight - minHeight) * 0.5;
}

export interface SceneSetup {
  scene: BABYLON.Scene;
  camera: BABYLON.UniversalCamera;
  ground: BABYLON.Mesh;
  heightmapData: Float32Array;
  characterController: BABYLON.PhysicsCharacterController | null;
  playerMesh: BABYLON.Mesh;
}

export function createScene(
  engine: BABYLON.Engine
): SceneSetup {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);
  scene.collisionsEnabled = true;

  // Transparent scene for CSS gradient background
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

  // Add distance fog like old games (Tribes 2 style)
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
  scene.fogDensity = 0.003;
  scene.fogColor = new BABYLON.Color3(0.4, 0.6, 0.8); // Matches sky gradient

  const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);
  light.intensity = 0.7;

  const dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-1, -2, -1), scene);
  dirLight.intensity = 0.5;

  const { dataUrl: heightmapTexture, heightmapData } = createHeightmapTexture();

  // Calculate safe spawn position above terrain
  const spawnX = 0;
  const spawnZ = -50;
  const spawnTerrainHeight = getTerrainHeight(heightmapData, spawnX, spawnZ);
  const spawnY = Math.max(spawnTerrainHeight + 10, 20); // Spawn at least 10 units above terrain, min 20

  const camera = new BABYLON.UniversalCamera('camera', new BABYLON.Vector3(spawnX, spawnY, spawnZ), scene);
  camera.setTarget(BABYLON.Vector3.Zero());
  camera.fov = 1.57; // 90 degrees default, will be updated reactively
  camera.minZ = 0.1;
  camera.checkCollisions = false; // Disabled - using custom physics for player movement
  camera.applyGravity = false; // Disabled - using custom physics
  camera.ellipsoid = new BABYLON.Vector3(1, 1, 1);

  // Create debug HUD using HTML element (only if it doesn't exist)
  let debugHud = document.getElementById('debug-hud');
  if (!debugHud) {
    debugHud = document.createElement('div');
    debugHud.id = 'debug-hud';
    debugHud.style.cssText = `
      position: fixed;
      top: 10px;
      left: 10px;
      color: white;
      font-family: monospace;
      font-size: 16px;
      background: rgba(0, 0, 0, 0.5);
      padding: 10px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 1000;
    `;
    document.body.appendChild(debugHud);
  }

  // Update debug HUD every frame
  scene.registerBeforeRender(() => {
    // Raycast from bottom of capsule (camera position - 1 unit down for capsule height)
    const capsuleBottom = camera.position.clone();
    capsuleBottom.y -= 1.0; // Approximate capsule half-height
    const ray = new BABYLON.Ray(capsuleBottom, new BABYLON.Vector3(0, -1, 0), 1000);
    const hit = scene.pickWithRay(ray, (mesh) => mesh === ground);
    
    if (hit && hit.hit) {
      const distance = hit.distance;
      const sign = distance >= 0 ? ' ' : '';
      debugHud.textContent = `Ground Distance: ${sign}${distance.toFixed(2)}m\nPosition: ${camera.position.y.toFixed(2)}m`;
    } else {
      // If no hit, raycast from high above to check if player is under terrain
      const highPoint = capsuleBottom.clone();
      highPoint.y += 100;
      const rayFromAbove = new BABYLON.Ray(highPoint, new BABYLON.Vector3(0, -1, 0), 1000);
      const hitFromAbove = scene.pickWithRay(rayFromAbove, (mesh) => mesh === ground);
      
      if (hitFromAbove && hitFromAbove.hit) {
        // Player is under terrain - show negative distance
        const distance = hitFromAbove.distance;
        const playerDepth = 100 - distance; // How far under terrain
        debugHud.textContent = `Ground Distance: -${playerDepth.toFixed(2)}m (UNDER TERRAIN)\nPosition: ${camera.position.y.toFixed(2)}m`;
      } else {
        debugHud.textContent = `Ground Distance:  No hit\nPosition: ${camera.position.y.toFixed(2)}m`;
      }
    }
  });

  // Print debug info to console every second

  const ground = BABYLON.MeshBuilder.CreateGroundFromHeightMap(
    'ground',
    heightmapTexture,
    {
      width: 500,
      height: 500,
      subdivisions: 128,
      minHeight: 0,
      maxHeight: 30,
      updatable: false
    },
    scene
  );

  const groundMat = new BABYLON.ShaderMaterial('terrainMat', scene, {
    vertex: 'terrain',
    fragment: 'terrain'
  }, {
    attributes: ['position', 'normal', 'uv'],
    uniforms: ['worldViewProjection', 'world', 'view', 'projection', 'heightMin', 'heightMax']
  });

  // Set height range for blending
  groundMat.setFloat('heightMin', 0);
  groundMat.setFloat('heightMax', 30);

  // Register custom shader for height-based terrain texturing with procedural noise
  BABYLON.Effect.ShadersStore['terrainVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;
    uniform mat4 worldViewProjection;
    uniform mat4 world;
    varying vec3 vPosition;
    varying vec3 vNormal;
    varying vec2 vUv;
    
    void main() {
      vPosition = (world * vec4(position, 1.0)).xyz;
      vNormal = mat3(world) * normal;
      vUv = uv;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;

  BABYLON.Effect.ShadersStore['terrainFragmentShader'] = `
    precision highp float;
    varying vec3 vPosition;
    varying vec3 vNormal;
    varying vec2 vUv;
    uniform float heightMin;
    uniform float heightMax;
    
    // Simple hash function
    float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }
    
    // 2D Noise with smooth interpolation
    float noise(vec2 st) {
      vec2 i = floor(st);
      vec2 f = fract(st);
      
      // Smooth interpolation
      vec2 u = f * f * (3.0 - 2.0 * f);
      
      return mix(
        mix(random(i + vec2(0.0, 0.0)), random(i + vec2(1.0, 0.0)), u.x),
        mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }
    
    // Fractal Brownian Motion
    float fbm(vec2 st, int octaves) {
      float value = 0.0;
      float amplitude = 0.5;
      float frequency = 1.0;
      
      for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * noise(st * frequency);
        amplitude *= 0.5;
        frequency *= 2.0;
      }
      
      return value;
    }
    
    // Terrain colors
    vec3 sandColor = vec3(0.76, 0.70, 0.50);
    vec3 grassColor = vec3(0.35, 0.55, 0.25);
    vec3 darkGrassColor = vec3(0.25, 0.40, 0.15);
    vec3 rockColor = vec3(0.45, 0.42, 0.38);
    vec3 darkRockColor = vec3(0.30, 0.28, 0.25);
    vec3 snowColor = vec3(0.95, 0.95, 0.97);
    
    void main() {
      float height = vPosition.y;
      float normalizedHeight = (height - heightMin) / (heightMax - heightMin);
      
      // Calculate slope from normal
      float slope = 1.0 - normalize(vNormal).y;
      
      // Multi-scale noise for texture variation
      float detailNoise = fbm(vPosition.xz * 0.5, 4);
      float fineNoise = fbm(vPosition.xz * 2.0, 2);
      float combinedNoise = detailNoise * 0.7 + fineNoise * 0.3;
      
      vec3 color;
      vec3 darkVariant;
      
      // Height-based blending with smooth transitions
      if (normalizedHeight < 0.2) {
        // Sand at low elevations
        color = sandColor;
        darkVariant = sandColor * 0.8;
      } else if (normalizedHeight < 0.4) {
        // Blend sand to grass
        float t = (normalizedHeight - 0.2) / 0.2;
        color = mix(sandColor, grassColor, t);
        darkVariant = mix(sandColor * 0.8, darkGrassColor, t);
      } else if (normalizedHeight < 0.7) {
        // Grass
        color = grassColor;
        darkVariant = darkGrassColor;
      } else if (normalizedHeight < 0.85) {
        // Blend grass to rock
        float t = (normalizedHeight - 0.7) / 0.15;
        color = mix(grassColor, rockColor, t);
        darkVariant = mix(darkGrassColor, darkRockColor, t);
      } else if (normalizedHeight < 0.95) {
        // Rock
        color = rockColor;
        darkVariant = darkRockColor;
      } else {
        // Blend rock to snow at peaks
        float t = (normalizedHeight - 0.95) / 0.05;
        color = mix(rockColor, snowColor, t);
        darkVariant = mix(darkRockColor, snowColor * 0.95, t);
      }
      
      // Apply noise for texture variation
      color = mix(color, darkVariant, combinedNoise * 0.5);
      
      // Slope-based texturing - rock on steep surfaces
      float rockWeight = smoothstep(0.3, 0.7, slope);
      vec3 slopeColor = mix(rockColor, darkRockColor, combinedNoise);
      color = mix(color, slopeColor, rockWeight);
      
      // Simple lighting
      vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
      float diff = max(dot(normalize(vNormal), lightDir), 0.0);
      color *= (0.4 + 0.6 * diff);
      
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  ground.material = groundMat;

  ground.receiveShadows = true;
  ground.checkCollisions = false; // Disabled - using custom physics for all collision

  // Physics disabled - using custom physics system instead

  // Create player mesh for third person view
  const playerMesh = BABYLON.MeshBuilder.CreateCapsule('playerMesh', {
    height: 1.8,
    radius: 0.3
  }, scene);
  playerMesh.position = new BABYLON.Vector3(spawnX, spawnY, spawnZ);
  playerMesh.setEnabled(false); // Hidden by default (first person)
  
  const playerMat = new BABYLON.StandardMaterial('playerMat', scene);
  playerMat.diffuseColor = new BABYLON.Color3(0.3, 0.5, 0.8);
  playerMat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
  playerMesh.material = playerMat;

  return { scene, camera, ground, heightmapData, characterController: null, playerMesh };
}
