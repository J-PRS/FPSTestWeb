import * as THREE from 'three';

const SIZE    = 500;
const SUBDIV  = 80;
const HSCALE  = 30;
const NSCALE  = 0.005;

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix+1, iy);
  const c = hash(ix, iy+1), d = hash(ix+1, iy+1);
  return a + (b-a)*ux + (c-a)*uy + (b-a+a-b+d-c)*ux*uy;
}

function fbm(x: number, y: number): number {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < 5; i++) {
    v    += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp  *= 0.5;
  }
  return v;
}

export function sampleHeight(wx: number, wz: number): number {
  const nx = wx * NSCALE, nz = wz * NSCALE;
  let h = fbm(nx, nz);
  h = (h - 0.06) / 0.88;
  h = Math.pow(Math.max(0, h), 0.6);
  return h * HSCALE;
}

interface TileMesh {
  mesh: THREE.Mesh;
  tx: number;
  tz: number;
}

export class Terrain {
  private scene: THREE.Scene;
  private tiles: TileMesh[] = [];
  private centerTX = 0;
  private centerTZ = 0;
  private mat: THREE.MeshLambertMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.mat = new THREE.MeshLambertMaterial({ color: 0x5a7a3a, side: THREE.DoubleSide });
    for (let tz = -1; tz <= 1; tz++)
      for (let tx = -1; tx <= 1; tx++)
        this.tiles.push(this.buildTile(tx, tz));
  }

  private buildTile(tx: number, tz: number): TileMesh {
    const n = SUBDIV + 1;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(n * n * 3);
    const uvs       = new Float32Array(n * n * 2);
    const indices: number[] = [];

    const ox = tx * SUBDIV;
    const oz = tz * SUBDIV;
    const step = SIZE / SUBDIV;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = (ox + ix) * step;
        const wz = (oz + iz) * step;
        const wy = sampleHeight(wx, wz);
        const i  = (iz * n + ix) * 3;
        positions[i]   = wx;
        positions[i+1] = wy;
        positions[i+2] = wz;
        const u = (iz * n + ix) * 2;
        uvs[u]   = ix / SUBDIV * 4;
        uvs[u+1] = iz / SUBDIV * 4;
      }
    }

    for (let iz = 0; iz < SUBDIV; iz++) {
      for (let ix = 0; ix < SUBDIV; ix++) {
        const i = iz * n + ix;
        indices.push(i, i+n, i+1, i+1, i+n, i+n+1);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return { mesh, tx, tz };
  }

  update(px: number, pz: number) {
    const step = SIZE / SUBDIV;
    const ptx = Math.round(px / (SIZE));
    const ptz = Math.round(pz / (SIZE));
    if (ptx === this.centerTX && ptz === this.centerTZ) return;
    this.centerTX = ptx;
    this.centerTZ = ptz;
    for (const tile of this.tiles) {
      const ntx = ptx + tile.tx;
      const ntz = ptz + tile.tz;
      this.scene.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      const rebuilt = this.buildTile(ntx - ptx + tile.tx, ntz - ptz + tile.tz);
      // offset in world space
      tile.mesh = rebuilt.mesh;
    }
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }
}
