import * as pc from 'playcanvas';

// Simple noise functions for terrain generation
class SimpleNoise {
  static hash(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  static valueNoise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);
    const a = this.hash(ix, iy);
    const b = this.hash(ix + 1.0, iy);
    const c = this.hash(ix, iy + 1.0);
    const d = this.hash(ix + 1.0, iy + 1.0);
    return a + (b - a) * ux + (c - a) * uy + (b - a + a - b + d - c) * ux * uy;
  }

  static fbm(x: number, y: number, octaves: number): number {
    let v = 0;
    let amp = 0.5;
    let freq = 1.0;
    for (let i = 0; i < octaves; i++) {
      v += this.valueNoise(x * freq, y * freq) * amp;
      freq *= 2.0;
      amp *= 0.5;
    }
    return v;
  }
}

export class Terrain {
  app: pc.Application;
  SIZE: number;
  SUBDIV: number;
  STEP: number;
  HSCALE: number;
  HM_WORLD_SCALE: number;
  entity: pc.Entity;
  heightmapData: Uint8ClampedArray | null;
  heightmapSize: number;

  constructor(app: pc.Application) {
    this.app = app;
    this.SIZE = 500;
    this.SUBDIV = 100;
    this.STEP = 5.0;
    this.HSCALE = 125.0;
    this.HM_WORLD_SCALE = 1500.0;
    
    this.entity = new pc.Entity('Terrain');
    this.app.root.addChild(this.entity);
    
    this.heightmapData = null;
    this.heightmapSize = 0;
    
    this.loadHeightmap().then(() => {
      this.createTerrainMesh();
    });
  }

  async loadHeightmap(): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get 2D context'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        
        this.heightmapData = imageData.data;
        this.heightmapSize = img.width;
        resolve();
      };
      img.onerror = reject;
      img.src = '/heightmaps/Vortex_Smooth2_2048.png';
    });
  }

  sampleHeightmap(wx: number, wz: number): number {
    if (!this.heightmapData) return 0;
    
    const u = ((wx / this.HM_WORLD_SCALE) % 1.0 + 1.0) % 1.0 * this.heightmapSize;
    const v = ((wz / this.HM_WORLD_SCALE) % 1.0 + 1.0) % 1.0 * this.heightmapSize;
    
    const x0 = Math.floor(u) % this.heightmapSize;
    const z0 = Math.floor(v) % this.heightmapSize;
    const x1 = (x0 + 1) % this.heightmapSize;
    const z1 = (z0 + 1) % this.heightmapSize;
    
    const fx = u - Math.floor(u);
    const fz = v - Math.floor(v);
    
    const h00 = this.getPixel(x0, z0);
    const h10 = this.getPixel(x1, z0);
    const h01 = this.getPixel(x0, z1);
    const h11 = this.getPixel(x1, z1);
    
    const h = h00 * (1 - fx) * (1 - fz) + 
              h10 * fx * (1 - fz) + 
              h01 * (1 - fx) * fz + 
              h11 * fx * fz;
    
    return h * this.HSCALE;
  }

  getPixel(x: number, z: number): number {
    if (!this.heightmapData) return 0;
    const idx = (z * this.heightmapSize + x) * 4;
    const r = this.heightmapData[idx];
    // Use red channel as height (grayscale image)
    return r / 255.0;
  }

  sampleHeight(wx: number, wz: number): number {
    if (this.heightmapData) {
      return this.sampleHeightmap(wx, wz);
    }
    // Fallback to procedural if heightmap not loaded yet
    const nx = wx * 0.0015;
    const nz = wz * 0.0015;
    let height = SimpleNoise.fbm(nx, nz, 4);
    height = (height - 0.06) / 0.88;
    height = Math.pow(Math.max(0.0, height), 0.6);
    return height * this.HSCALE;
  }

  createTerrainMesh(): void {
    const n = this.SUBDIV + 1;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Generate vertices
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = (ix - this.SUBDIV / 2) * this.STEP;
        const wz = (iz - this.SUBDIV / 2) * this.STEP;
        const wy = this.sampleHeight(wx, wz);
        
        positions.push(wx, wy, wz);
        uvs.push(ix / this.SUBDIV * 8, iz / this.SUBDIV * 8);
      }
    }

    // Generate indices
    for (let iz = 0; iz < this.SUBDIV; iz++) {
      for (let ix = 0; ix < this.SUBDIV; ix++) {
        const i = iz * n + ix;
        indices.push(i, i + n, i + 1);
        indices.push(i + 1, i + n, i + n + 1);
      }
    }

    // Calculate normals
    this.calculateNormals(positions, indices, normals);

    // Create mesh
    const mesh = new pc.Mesh(this.app.graphicsDevice);
    mesh.clear(true, false);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setUvs(0, uvs);
    mesh.setIndices(indices);
    mesh.update();

    // Create material
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(0.3, 0.35, 0.25);
    material.roughness = 0.8;
    material.metalness = 0.0;
    material.update();

    // Use render component to avoid model component shadow issues
    this.entity.addComponent('render');
    this.entity.render.meshInstances = [new pc.MeshInstance(mesh, material)];
  }

  calculateNormals(positions: number[], indices: number[], normals: number[]): void {
    // Reset normals
    for (let i = 0; i < normals.length; i++) {
      normals[i] = 0;
    }

    // Calculate face normals and accumulate
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      const v0 = new pc.Vec3(positions[i0], positions[i0 + 1], positions[i0 + 2]);
      const v1 = new pc.Vec3(positions[i1], positions[i1 + 1], positions[i1 + 2]);
      const v2 = new pc.Vec3(positions[i2], positions[i2 + 1], positions[i2 + 2]);

      const edge1 = new pc.Vec3().sub2(v1, v0);
      const edge2 = new pc.Vec3().sub2(v2, v0);
      const normal = new pc.Vec3().cross(edge1, edge2).normalize();

      normals[i0] += normal.x;
      normals[i0 + 1] += normal.y;
      normals[i0 + 2] += normal.z;
      normals[i1] += normal.x;
      normals[i1 + 1] += normal.y;
      normals[i1 + 2] += normal.z;
      normals[i2] += normal.x;
      normals[i2 + 1] += normal.y;
      normals[i2 + 2] += normal.z;
    }

    // Normalize all normals
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]);
      if (len > 0) {
        normals[i] /= len;
        normals[i + 1] /= len;
        normals[i + 2] /= len;
      }
    }
  }

  getHeight(wx: number, wz: number): number {
    return this.sampleHeight(wx, wz);
  }
}
