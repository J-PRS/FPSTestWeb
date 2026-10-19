/** Deterministic math for cross-engine replayed sims.
 *
 *  WHY: ECMAScript leaves Math.sin/cos/atan2/… implementation-defined —
 *  JavaScriptCore (Bun server) and V8 (browser client) return different
 *  ULPs on real inputs (measured: atan2 22% of inputs, hypot 41%,
 *  sin/cos ~1.5%). Sims that replay on BOTH engines (movement, ball,
 *  creatures, combat) then diverge sub-ULP per call and compound —
 *  phantom corrections, false replica-hash DESYNCs.
 *
 *  Anything built from +−×÷ and Math.sqrt is bit-identical across
 *  conforming engines (sqrt is correctly-rounded; measured identical).
 *  The implementations below use only those ops — accuracy is ~1e-13
 *  rad, plenty for game math, and identical bit-for-bit everywhere.
 *
 *  Server-only files (bot*, mode sims) keep native Math — they never
 *  compare bits across engines. sharedPurity bans the divergent natives
 *  except in the allowlisted server-side set. */

const {PI} = Math;

/* ---- sin/cos: Cody-Waite reduce to [-π/4, π/4], fdlibm polynomials --- */

// Two-part π/2 so k*pio2 subtracts without catastrophic cancellation.
const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
const INV_PIO2 = 0.6366197723675814; // 2/π

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.0875723212981748279e-09;
const C6 = -1.13596475577881948265e-11;

function sinSmall(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function cosSmall(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** |x| up to ~1e9; beyond that the range reduction loses the low bits —
 *  sim angles are always bounded well below that. */
function reduce(x: number): { r: number; k: number } {
  const k = Math.round(x * INV_PIO2);
  return { r: x - k * PIO2_HI - k * PIO2_LO, k };
}

export function dsin(x: number): number {
  if (x !== x) {return x;}
  const { r, k } = reduce(x);
  switch (((k % 4) + 4) % 4) {
    case 0: { return sinSmall(r);
    }
    case 1: { return cosSmall(r);
    }
    case 2: { return -sinSmall(r);
    }
    default: { return -cosSmall(r);
    }
  }
}

export function dcos(x: number): number {
  if (x !== x) {return x;}
  const { r, k } = reduce(x);
  switch (((k % 4) + 4) % 4) {
    case 0: { return cosSmall(r);
    }
    case 1: { return -sinSmall(r);
    }
    case 2: { return -cosSmall(r);
    }
    default: { return sinSmall(r);
    }
  }
}

/* ---- atan: double-angle-halve twice to |t| ≤ ~0.172, odd Taylor ----- */

function atanSmall(t: number): number {
  const z = t * t;
  // t ≤ 0.1716 → truncation error ~t^13/13 ≈ 7e-12.
  return t * (1 + z * (-1 / 3 + z * (1 / 5 + z * (-1 / 7 + z * (1 / 9 + z * (-1 / 11))))));
}

/** Deterministic atan on |x| ≤ 1 via atan(x) = 2·atan(x/(1+√(1+x²)))
 *  applied twice: 4·poly(t), t ≤ 0.1716. */
function atanUnit(x: number): number {
  let t = x;
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  return 4 * atanSmall(t);
}

const HALF_PI = PIO2_HI + PIO2_LO;
const QUARTER_PI = HALF_PI / 2;

export function datan(x: number): number {
  if (x !== x) {return x;}
  const ax = x < 0 ? -x : x;
  if (ax > 1) {
    const v = HALF_PI - atanUnit(1 / ax);
    return x < 0 ? -v : v;
  }
  // atan(x) = π/4 + atan((x-1)/(1+x)) folds [0.4142, 1] into the small range.
  if (ax > 0.41421356237309503) {
    const t = (ax - 1) / (ax + 1);
    const v = QUARTER_PI + atanUnit(t);
    return x < 0 ? -v : v;
  }
  const v = ax > 0.1716 ? atanUnit(ax) : atanSmall(ax);
  return x < 0 ? -v : v;
}

export function datan2(y: number, x: number): number {
  // fdlibm casing: degenerate inputs first, then |y/x| through atanUnit.
  if (x !== x || y !== y) {return x + y;} // NaN propagates like Math.atan2
  if (x === 0) {
    if (y === 0) {return y;} // ±0 preserved
    return y < 0 ? -HALF_PI : HALF_PI;
  }
  if (y === 0) {return x < 0 ? (1 / y < 0 ? -PI : PI) : y;}
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  // Both arguments to atanUnit stay ≤ 1 — fold the |y|>|x| half-plane
  // through atan(1/t) = π/2 − atan(t).
  const v = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  let r = x < 0 ? PI - v : v;
  if (y < 0) {r = -r;}
  return r;
}

/* ---- hypot: sqrt is correctly-rounded → identical across engines ---- */

/** drop-in for Math.hypot — sqrt is correctly-rounded and identical
 *  across engines; the naive squares are fine at game magnitudes. */
export function dhypot(...v: number[]): number {
  let s = 0;
  for (const x of v) {s += x * x;}
  return Math.sqrt(s);
}
