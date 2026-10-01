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

// One LineSegments for EVERY explosion's sparks — each blast leased its
// own mesh+draw before (~20 draws in a firefight); slots are contiguous
// SPARK_FLOATS ranges in a shared buffer.
const MAX_SPARKS = 1024;

class SparkBatch {
  geo = new THREE.BufferGeometry();
  posAttr = new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * SPARK_FLOATS), 3);
  colAttr = new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * SPARK_FLOATS), 3);
  mesh: THREE.LineSegments;
  private free: { start: number; count: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);
    this.mesh = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    }));
    this.mesh.layers.enable(BLOOM_LAYER);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  alloc(n: number): number {
    for (let i = 0; i < this.free.length; i++) {
      if (this.free[i]!.count >= n) {
        const s = this.free.splice(i, 1)[0]!;
        if (s.count > n) this.free.push({ start: s.start + n, count: s.count - n });
        return s.start;
      }
    }
    if (this.next + n > MAX_SPARKS) return -1;
    const s = this.next; this.next += n; return s;
  }

  release(start: number, n: number): void {
    this.posAttr.array.fill(0, start * SPARK_FLOATS, (start + n) * SPARK_FLOATS);
    this.colAttr.array.fill(0, start * SPARK_FLOATS, (start + n) * SPARK_FLOATS);
    this.free.push({ start, count: n });
    this.touch();
  }

  touch(): void {
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
}

let _batch: SparkBatch | null = null;

export class ExplosionSparks {
  private sparks: Spark[] = [];
  private batch: SparkBatch;
  private base = -1;

  constructor(private scene: THREE.Scene) {
    _batch ??= new SparkBatch(scene);
    this.batch = _batch;
  }

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

  /** Lease this blast's spark range in the shared batch — called once
   *  at the end of the spawn pass. */
  finalize(): void {
    const n = this.sparks.length;
    if (!n) return;
    this.base = this.batch.alloc(n);
    if (this.base < 0) { this.sparks = []; return; }
    for (let i = 0; i < n; i++) this.sparks[i]!.slice = (this.base + i) * SPARK_FLOATS;
  }

  update(dt: number): number {
    let alive = 0;
    if (this.base < 0) return 0;
    const posArr = this.batch.posAttr.array as Float32Array;
    const colArr = this.batch.colAttr.array as Float32Array;
    for (const spark of this.sparks) {
      if (spark.dead) continue;
      spark.elapsed += dt;
      if (spark.elapsed >= spark.life) {
        spark.dead = true;
        // Collapse the slice — degenerate segments rasterize nothing.
        posArr.fill(0, spark.slice, spark.slice + SPARK_FLOATS);
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

      this.writeSlice(spark, posArr, colArr);
    }
    if (alive) this.batch.touch();
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
    if (this.base >= 0) this.batch.release(this.base, this.sparks.length);
    this.base = -1;
    this.sparks = [];
  }
}
