/**
 * Simple terrain interface for server-side movement
 * Provides basic height and normal calculations without full terrain rendering
 */

export class SimpleTerrain {
  private heightmap: number[][] | null = null;
  private resolution: number = 2048;
  private scale: number = 1500.0; // World units per heightmap dimension (matches client HM_WORLD_SCALE)
  private heightScale: number = 125.0; // Height multiplier (matches client HSCALE)

  constructor() {
    // Initialize with flat terrain (height = 0 everywhere)
    this.heightmap = null;
  }

  /**
   * Load heightmap from PNG file
   * For now, we'll use a simple procedural heightmap that matches the client's Vortex terrain
   * Full implementation would use sharp or pngjs to load actual PNG files
   */
  async loadHeightmap(path: string): Promise<void> {
    // For now, generate a procedural heightmap that approximates the Vortex terrain
    // This is a placeholder - full implementation would load the actual PNG file
    this.heightmap = this.generateProceduralHeightmap();
  }

  /**
   * Generate a procedural heightmap that approximates the Vortex terrain
   * This is a placeholder for loading the actual PNG file
   */
  private generateProceduralHeightmap(): number[][] {
    const heightmap: number[][] = [];
    for (let z = 0; z < this.resolution; z++) {
      heightmap[z] = [];
      for (let x = 0; x < this.resolution; x++) {
        // Simple procedural terrain using sine waves
        const nx = x / this.resolution;
        const nz = z / this.resolution;
        const height = Math.sin(nx * 10) * Math.cos(nz * 10) * 0.5 + 0.5;
        heightmap[z][x] = height;
      }
    }
    return heightmap;
  }

  getHeight(x: number, z: number): number {
    if (!this.heightmap) {
      return 0; // Flat terrain if no heightmap loaded
    }

    // Sample from heightmap with bilinear interpolation
    const u = (((x / this.scale) % 1.0) + 1.0) % 1.0 * this.resolution;
    const v = (((z / this.scale) % 1.0) + 1.0) % 1.0 * this.resolution;
    const x0 = Math.floor(u) % this.resolution;
    const z0 = Math.floor(v) % this.resolution;
    const x1 = (x0 + 1) % this.resolution;
    const z1 = (z0 + 1) % this.resolution;
    const fx = u - Math.floor(u);
    const fz = v - Math.floor(v);

    const h00 = this.heightmap[z0][x0];
    const h10 = this.heightmap[z0][x1];
    const h01 = this.heightmap[z1][x0];
    const h11 = this.heightmap[z1][x1];

    // Bilinear interpolation
    const h = h00 * (1 - fx) * (1 - fz) +
              h10 * fx * (1 - fz) +
              h01 * (1 - fx) * fz +
              h11 * fx * fz;

    return h * this.heightScale;
  }

  getNormal(x: number, z: number): { x: number; y: number; z: number } {
    if (!this.heightmap) {
      return { x: 0, y: 1, z: 0 }; // Flat terrain normal
    }

    // Calculate normal from heightmap gradients
    const epsilon = 1.0;
    const hL = this.getHeight(x - epsilon, z);
    const hR = this.getHeight(x + epsilon, z);
    const hD = this.getHeight(x, z - epsilon);
    const hU = this.getHeight(x, z + epsilon);

    // Gradient vectors
    const dx = (hR - hL) / (2 * epsilon);
    const dz = (hU - hD) / (2 * epsilon);

    // Normal is perpendicular to the gradient
    const normal = {
      x: -dx,
      y: 1.0,
      z: -dz
    };

    // Normalize
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    return {
      x: normal.x / length,
      y: normal.y / length,
      z: normal.z / length
    };
  }
}
