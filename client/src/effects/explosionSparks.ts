import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';

// Batched trail sparks — every explosion's debris streaks baked into ONE
// LineSegments after construction (~40 sparks → 1 draw call where each
// used to be its own Line + geometry + material). Split from
// explosion.ts; owns the spark data, the shared position/color buffers,
// and the per-frame trail write.

export const SPARK_TRAIL = 8; // max trail points per spark
// Trail polyline → segment pairs: SPARK_TRAIL points make TRAIL-1
// segments = 14 verts = 42 floats per spark in the shared buffer.
const SPARK_FLOATS = (SPARK_TRAIL - 1) * 2 * 3;

export interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  elapsed: number;
  dead: boolean;
  // Fixed ring buffer of trail points — no Vector3 array churn
  trailBuf: Float32Array; // SPARK_TRAIL * 3
  trailHead: number;
  trailCount: number;
  // Base color + opacity — the shared vertex-color attribute fades by
  // writing color*(1-t)*o each frame (additive blending: black = gone).
  r: number; g: number; b: number; o: number;
  slice: number; // float offset into the shared position/color arrays
}

export class ExplosionSparks {
  private sparks: Spark[] = [];
  private mesh: THREE.LineSegments | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private colAttr: THREE.BufferAttribute | null = null;

  constructor(private scene: THREE.Scene) {}

  /** Register a spark — spawn code fills vel/life/color on the returned
   *  record before finalize() bakes the batch. */
  alloc(pos: THREE.Vector3): Spark {
    const spark: Spark = {
      pos: pos.clone(), vel: new THREE.Vector3(), life: 0, elapsed: 0, dead: false,
      trailBuf: new Float32Array(SPARK_TRAIL * 3), trailHead: 0, trailCount: 0,
      r: 1, g: 1, b: 1, o: 0.8, slice: 0,
    };
    this.sparks.push(spark);
    return spark;
  }

  /** Bake every registered spark into the single LineSegments — called
   *  once at the end of the spawn pass. */
  finalize(): void {
    const n = this.sparks.length;
    if (!n) return;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * SPARK_FLOATS), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * SPARK_FLOATS), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.layers.enable(BLOOM_LAYER);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    for (let i = 0; i < n; i++) this.sparks[i].slice = i * SPARK_FLOATS;
  }

  update(dt: number): number {
    let alive = 0;
    const posArr = this.posAttr?.array as Float32Array | undefined;
    const colArr = this.colAttr?.array as Float32Array | undefined;
    for (const spark of this.sparks) {
      if (spark.dead) continue;
      spark.elapsed += dt;
      if (spark.elapsed >= spark.life) {
        spark.dead = true;
        // Collapse the slice — degenerate segments rasterize nothing.
        if (posArr) posArr.fill(0, spark.slice, spark.slice + SPARK_FLOATS);
        continue;
      }
      alive++;

      // Apply gravity
      spark.vel.y -= 40 * dt;

      // Update position
      spark.pos.addScaledVector(spark.vel, dt);

      // Push into trail ring buffer
      const tb = spark.trailBuf;
      const h = spark.trailHead;
      tb[h * 3] = spark.pos.x; tb[h * 3 + 1] = spark.pos.y; tb[h * 3 + 2] = spark.pos.z;
      spark.trailHead = (h + 1) % SPARK_TRAIL;
      if (spark.trailCount < SPARK_TRAIL) spark.trailCount++;

      if (posArr && colArr) this.writeSlice(spark, posArr, colArr);
    }
    if (alive && this.posAttr && this.colAttr) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
    return alive;
  }

  // Write this spark's trail slice: oldest→newest segment pairs, tail
  // dims toward the oldest point. Fade lives in vertex color — additive
  // blending makes black invisible, so color*(1-t)*o replaces the old
  // per-Line material opacity.
  private writeSlice(spark: Spark, posArr: Float32Array, colArr: Float32Array): void {
    const f = (1 - spark.elapsed / spark.life) * spark.o * EMIT_GAIN;
    const cr = spark.r * f, cg = spark.g * f, cb = spark.b * f;
    const tb = spark.trailBuf;
    let w = spark.slice;
    const n = spark.trailCount;
    for (let i = 0; i < SPARK_TRAIL - 1; i++) {
      if (i < n - 1) {
        const s0 = (spark.trailHead - n + i + SPARK_TRAIL) % SPARK_TRAIL;
        const s1 = (s0 + 1) % SPARK_TRAIL;
        posArr[w] = tb[s0 * 3]; posArr[w + 1] = tb[s0 * 3 + 1]; posArr[w + 2] = tb[s0 * 3 + 2];
        posArr[w + 3] = tb[s1 * 3]; posArr[w + 4] = tb[s1 * 3 + 1]; posArr[w + 5] = tb[s1 * 3 + 2];
        const tail = 0.35 + 0.65 * (i / Math.max(1, n - 1));
        colArr[w] = cr * tail; colArr[w + 1] = cg * tail; colArr[w + 2] = cb * tail;
        colArr[w + 3] = cr; colArr[w + 4] = cg; colArr[w + 5] = cb;
      } else {
        posArr.fill(0, w, w + 6);
        colArr.fill(0, w, w + 6);
      }
      w += 6;
    }
  }

  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
      this.posAttr = null;
      this.colAttr = null;
    }
    this.sparks = [];
  }
}
