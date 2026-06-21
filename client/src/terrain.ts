import * as THREE from 'three';

const SIZE = 500.0;
const SUBDIV = 100;
const STEP = SIZE / SUBDIV;
const HSCALE = 125.0;
const HM_WORLD_SCALE = 1500.0;

let hmData: Uint8ClampedArray | null = null;
let hmSize = 0;

export async function loadHeightmap(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      hmSize = img.width;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      hmData = ctx.getImageData(0, 0, img.width, img.height).data; // RGBA
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}

function hmSample(x: number, z: number): number {
  const idx = (z * hmSize + x) * 4;
  return hmData![idx] / 255.0; // R channel 0..1
}

function sampleHeightmap(wx: number, wz: number): number {
  const u = (((wx / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize;
  const v = (((wz / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize;
  const x0 = Math.floor(u) % hmSize;
  const z0 = Math.floor(v) % hmSize;
  const x1 = (x0 + 1) % hmSize;
  const z1 = (z0 + 1) % hmSize;
  const fx = u - Math.floor(u);
  const fz = v - Math.floor(v);
  const h =
    hmSample(x0, z0) * (1 - fx) * (1 - fz) +
    hmSample(x1, z0) * fx * (1 - fz) +
    hmSample(x0, z1) * (1 - fx) * fz +
    hmSample(x1, z1) * fx * fz;
  return h * HSCALE;
}

export function sampleHeight(wx: number, wz: number): number {
  if (hmData) return sampleHeightmap(wx, wz);
  return 0;
}

export function sampleNormal(wx: number, wz: number): THREE.Vector3 {
  const e = STEP * 0.5;
  const hL = sampleHeight(wx - e, wz);
  const hR = sampleHeight(wx + e, wz);
  const hD = sampleHeight(wx, wz - e);
  const hU = sampleHeight(wx, wz + e);
  return new THREE.Vector3(hL - hR, 2.0 * e, hD - hU).normalize();
}

interface TileEntry {
  mesh: THREE.Mesh;
  tileX: number;
  tileZ: number;
}

const terrainVert = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;
  void main() {
    vNormal   = normalize(mat3(transpose(inverse(modelMatrix))) * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vCameraPos = cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const terrainFrag = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float hscale;
  uniform int terrainPreset; // 0=mixed, 1=desert
  uniform vec3 fogColor;
  uniform float fogDensity;

  // --- hash + value noise with analytic derivatives ---
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  vec3 noised(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    vec2 du = 6.0*f*(1.0-f);
    float a = hash(i+vec2(0,0));
    float b = hash(i+vec2(1,0));
    float c = hash(i+vec2(0,1));
    float d = hash(i+vec2(1,1));
    float v = a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
    vec2  g = du * (vec2(b-a, c-a) + (a-b-c+d)*u.yx);
    return vec3(v, g);
  }
  float noise(vec2 p) { return noised(p).x; }

  // --- Derivative erosion FBM (suppresses detail on steep slopes) ---
  const mat2 m2 = mat2(0.8, -0.6, 0.6, 0.8);
  float fbmErosion(vec2 p, int octaves) {
    float v=0.0, a=0.5;
    vec2 d = vec2(0.0);
    for(int i=0;i<16;i++){
      if(i >= octaves) break;
      vec3 n = noised(p);
      d += n.yz;
      v += a * n.x / (1.0 + dot(d,d));
      a *= 0.5;
      p = m2 * p * 2.0;
    }
    return v;
  }
  float fbm(vec2 p) { return fbmErosion(p, 6); }

  // --- Worley / cell noise for rocky variation ---
  float worley(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell), hash(cell+vec2(31.41,27.18)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Second Worley layer at different scale for rock complexity ---
  float worley2(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell+vec2(57.3,91.7)), hash(cell+vec2(13.4,87.2)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Triplanar noise sampling (prevents stretching on cliffs) ---
  float triplanarNoise(vec3 p, float scale) {
    vec3 w = abs(vNormal);
    w = w / (w.x + w.y + w.z);
    float nx = noise(p.zy * scale);
    float ny = noise(p.xz * scale);
    float nz = noise(p.xy * scale);
    return nx * w.x + ny * w.y + nz * w.z;
  }

  // --- Stochastic texture bombing (random detail patches) ---
  float stochastic(vec3 p, float scale, float density) {
    vec3 i = floor(p * scale);
    float sum = 0.0;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
      vec3 cell = i + vec3(x,y,z);
      vec3 rnd = vec3(hash(cell.xy), hash(cell.yz), hash(cell.zx));
      vec3 center = (cell + rnd) / scale;
      float d = length(p - center);
      if(d < 0.5) sum += 1.0 - d * 2.0;
    }
    return clamp(sum * density, 0.0, 1.0);
  }

  // --- Directional erosion noise (creates river/drainage patterns) ---
  vec3 erosionNoise(vec2 p, vec2 dir) {
    vec2 ip = floor(p);
    vec2 fp = fract(p) - 0.5;
    float va = 0.0, wt = 0.0;
    for(int i=-2;i<=1;i++) for(int j=-2;j<=1;j++){
      vec2 o = vec2(float(i), float(j));
      vec2 h = vec2(hash(ip-o), hash(ip-o+vec2(37.0,17.0))) * 0.5;
      vec2 pp = fp + o + h;
      float d = dot(pp, pp);
      float w = exp(-d * 2.0);
      float mag = dot(pp, dir);
      va += cos(mag * 6.283) * w;
      wt += w;
    }
    return vec3(va / wt, 0.0, 0.0);
  }

  float terrainErosion(vec2 p, vec2 baseSlope) {
    float e = 0.0, a = 0.5;
    vec2 dir = normalize(baseSlope + vec2(0.001));
    for(int i=0;i<5;i++){
      vec3 n = erosionNoise(p * 4.0, dir);
      e += a * n.x;
      dir = normalize(dir + vec2(0.0, 0.0) * 1.5);
      a *= 0.5;
      p *= 2.0;
    }
    return e;
  }

  void main() {
    float slope  = 1.0 - clamp(vNormal.y, 0.0, 1.0);
    float height = clamp(vWorldPos.y / hscale, 0.0, 1.0);

    // --- multi-scale UVs ---
    vec2 uv    = vWorldPos.xz * 0.032;
    vec2 uvMed = vWorldPos.xz * 0.14;
    vec2 uvFin = vWorldPos.xz * 0.72;

    // domain-warp the base FBM
    vec2 warp = vec2(fbm(uv + vec2(0.0, 0.0)), fbm(uv + vec2(5.2, 1.3)));
    float macro  = fbm(uv  + 0.8 * warp);       // large features
    float medium = fbm(uvMed + vec2(3.1, 7.4));  // medium clumping
    float micro  = noise(uvFin) * 0.5 + noise(uvFin*2.8+1.7)*0.5; // fine surface
    float cell   = worley(uvMed * 1.4);          // rocky cell pattern
    float cell2  = worley2(uvMed * 2.1);         // second rock detail layer

    // triplanar rock detail (prevents stretching on cliffs)
    float triRock = triplanarNoise(vWorldPos, 0.22);
    float triDetail = triplanarNoise(vWorldPos, 0.85);

    // stochastic patches (random grass tufts, rock outcrops)
    float grassPatch = stochastic(vWorldPos, 0.18, 0.35);
    float rockPatch  = stochastic(vWorldPos, 0.12, 0.25);

    // directional erosion (drainage patterns)
    vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
    float drainage = terrainErosion(uvMed, slopeDir);

    // composite detail
    float detail = macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10 + drainage*0.05;

    // --- rich saturated palette ---
    // sand: pale gold in lowest areas
    vec3 cSand  = vec3(0.68, 0.58, 0.32)
                + micro  * vec3(0.08, 0.06, 0.02);
    // grass: vibrant green with variation
    vec3 cGrass = vec3(0.18, 0.52, 0.06)
                + medium * vec3(0.08, 0.12, 0.02)
                + micro  * vec3(0.05, 0.07, 0.01)
                + grassPatch * vec3(0.04, 0.08, 0.0);
    // dry/golden grass in mid elevations
    vec3 cDry   = vec3(0.62, 0.50, 0.16)
                + macro  * vec3(0.12, 0.10, 0.04);
    // dirt: warm reddish-brown
    vec3 cDirt  = vec3(0.52, 0.30, 0.12)
                + medium * vec3(0.10, 0.06, 0.02)
                + cell   * vec3(0.06, 0.04, 0.01);
    // rock: grey with cell-noise cracks and triplanar detail
    vec3 cRock  = vec3(0.36, 0.32, 0.26)
                + cell   * vec3(0.14, 0.12, 0.10)
                + cell2  * vec3(0.08, 0.07, 0.06)
                + triRock * vec3(0.06, 0.05, 0.04)
                + rockPatch * vec3(0.08, 0.07, 0.05);
    // moss/lichen on rocks in damp areas
    vec3 cMoss  = vec3(0.28, 0.42, 0.14)
                + cell2 * vec3(0.06, 0.08, 0.02);
    // dark rock on very steep slopes
    vec3 cCliff = vec3(0.22, 0.20, 0.16)
                + cell   * vec3(0.10, 0.09, 0.07)
                + triRock * vec3(0.08, 0.07, 0.05);
    // wet patches in valleys (darker, slightly blueish)
    vec3 cWet   = vec3(0.38, 0.40, 0.34);

    // --- desert preset (sand + dirt + rock only) ---
    if(terrainPreset == 1) {
      // More yellow sand for flats
      vec3 cDesertSand = vec3(0.78, 0.66, 0.28)
                      + micro * vec3(0.10, 0.08, 0.02);
      // Darker rocks for slopes
      vec3 cDesertRock = vec3(0.28, 0.24, 0.18)
                      + cell * vec3(0.12, 0.10, 0.08)
                      + triRock * vec3(0.08, 0.07, 0.05);
      vec3 cDesertCliff = vec3(0.18, 0.16, 0.12)
                      + cell * vec3(0.10, 0.09, 0.07);

      vec3 col = cDesertSand;
      col = mix(col, cDirt, smoothstep(0.05, 0.25, height));
      col = mix(col, cDesertRock, smoothstep(0.30, 0.60, height));
      float slopeBlend = smoothstep(0.18, 0.45, slope);
      vec3 slopeCol = mix(cDirt, cDesertCliff, smoothstep(0.30, 0.65, slope));
      col = mix(col, slopeCol, slopeBlend);
      col *= 0.86 + 0.28 * detail;
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow + vec3(rim);
      col *= lit;
      float fogDist = length(vWorldPos - vCameraPos);
      float fogFactor = 1.0 - exp(-fogDensity * fogDist);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(col, 1.0);
      return;
    }

    // --- height blend (mixed preset) ---
    vec3 col = cSand;
    col = mix(col,   cDry,   smoothstep(0.05, 0.15, height));
    col = mix(col,   cGrass, smoothstep(0.12, 0.35, height));
    col = mix(col,   cDirt,  smoothstep(0.38, 0.56, height));
    col = mix(col,   cRock,  smoothstep(0.52, 0.78, height));

    // --- slope blend ---
    float slopeBlend = smoothstep(0.18, 0.45, slope);
    vec3 slopeCol = mix(cDirt, cCliff, smoothstep(0.30, 0.65, slope));
    col = mix(col, slopeCol, slopeBlend);

    // --- moss on rocks in mid-height damp areas ---
    float mossMask = smoothstep(0.25, 0.55, height) * (1.0 - smoothstep(0.60, 0.75, height));
    float mossSlope = smoothstep(0.25, 0.50, slope);
    col = mix(col, cMoss, mossMask * mossSlope * cell2 * 0.6);

    // --- wet patches in low valleys ---
    float wetMask = smoothstep(0.0, 0.12, height) * (1.0 - smoothstep(0.18, 0.25, height));
    col = mix(col, cWet, wetMask * macro * 0.4);

    // --- drainage channels (darker, follow slope direction) ---
    float drainageMask = smoothstep(0.0, 0.6, drainage) * smoothstep(0.1, 0.8, slope);
    vec3 cDrain = vec3(0.25, 0.28, 0.22);
    col = mix(col, cDrain, drainageMask * 0.35);

    // --- micro darkening in concavities via detail ---
    col *= 0.86 + 0.28 * detail;

    // --- lighting ---
    float diff   = max(dot(vNormal, sunDir), 0.0);
    float shadow = diff * diff;
    // subtle fresnel-like rim on slopes facing away
    float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
    vec3 lit = ambientColor + sunColor * shadow + vec3(rim);
    col *= lit;

    // --- exponential fog ---
    float dist = length(vWorldPos - vCameraPos);
    float fogFactor = 1.0 - exp(-fogDensity * dist);
    col = mix(col, fogColor, fogFactor);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Terrain {
  private scene: THREE.Scene;
  private tiles: TileEntry[] = [];
  private material: THREE.ShaderMaterial;
  private centerTX = 0;
  private centerTZ = 0;

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.scene = scene;

    this.material = new THREE.ShaderMaterial({
      vertexShader: terrainVert,
      fragmentShader: terrainFrag,
      uniforms: {
        sunDir:        { value: sunDir.clone().normalize() },
        sunColor:      { value: new THREE.Color(1.0, 0.94, 0.8) },
        ambientColor:  { value: new THREE.Color(0.18, 0.22, 0.28) },
        hscale:        { value: HSCALE },
        terrainPreset: { value: 1 }, // 0=mixed, 1=desert
        fogColor:      { value: new THREE.Color(0x88bbdd) },
        fogDensity:    { value: 0.006 },
      },
    });

    for (let tz = -1; tz <= 1; tz++) {
      for (let tx = -1; tx <= 1; tx++) {
        this.tiles.push(this.buildTile(tx, tz));
      }
    }
  }

  private buildTile(tileX: number, tileZ: number): TileEntry {
    const n = SUBDIV + 1;
    const positions = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);

    const cornerX = tileX * SUBDIV - Math.floor(SUBDIV / 2);
    const cornerZ = tileZ * SUBDIV - Math.floor(SUBDIV / 2);

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = (cornerX + ix) * STEP;
        const wz = (cornerZ + iz) * STEP;
        const wy = sampleHeight(wx, wz);
        const vi = (iz * n + ix);
        positions[vi * 3 + 0] = wx;
        positions[vi * 3 + 1] = wy;
        positions[vi * 3 + 2] = wz;
        uvs[vi * 2 + 0] = (ix / SUBDIV) * 8;
        uvs[vi * 2 + 1] = (iz / SUBDIV) * 8;
      }
    }

    // Compute smooth normals via finite differences
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = (cornerX + ix) * STEP;
        const wz = (cornerZ + iz) * STEP;
        const norm = sampleNormal(wx, wz);
        const vi = iz * n + ix;
        normals[vi * 3 + 0] = norm.x;
        normals[vi * 3 + 1] = norm.y;
        normals[vi * 3 + 2] = norm.z;
      }
    }

    const indices: number[] = [];
    for (let iz = 0; iz < SUBDIV; iz++) {
      for (let ix = 0; ix < SUBDIV; ix++) {
        const i = iz * n + ix;
        indices.push(i, i + n, i + 1);
        indices.push(i + 1, i + n, i + n + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return { mesh, tileX, tileZ };
  }

  update(px: number, pz: number): void {
    const ptx = Math.round(px / SIZE);
    const ptz = Math.round(pz / SIZE);
    if (ptx === this.centerTX && ptz === this.centerTZ) return;

    this.centerTX = ptx;
    this.centerTZ = ptz;

    // Remove old tiles
    for (const t of this.tiles) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    this.tiles = [];

    for (let tz = -1; tz <= 1; tz++) {
      for (let tx = -1; tx <= 1; tx++) {
        this.tiles.push(this.buildTile(this.centerTX + tx, this.centerTZ + tz));
      }
    }
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }

  getNormal(wx: number, wz: number): THREE.Vector3 {
    return sampleNormal(wx, wz);
  }
}
