/**
 * vidcmp.ts — SSIM compare between two mp4s.
 *
 *   bun _tools/e2e/vidcmp.ts live.mp4 replay.mp4 [lagScan] [segSec]
 *
 * Decodes both to 80x45 gray @10fps via ffmpeg rawvideo (no decoder dep),
 * then computes windowed SSIM (8x8, stride 2) in-process — raw abs luma
 * diff proved useless on this content (sandy terrain is self-similar;
 * nondeterministic particles dominate abs diff; a MISMATCHED pair scored
 * better). SSIM compares local structure, which is what replay fidelity
 * actually changes.
 *
 * Alignment is per-SEGMENT: the live video runs on wall clock while the
 * demo clock accumulates clamped dt, so the offset drifts across the
 * window — each ~2s segment picks its own best lag.
 */
import { execFileSync } from 'node:child_process';

export const CW = 80, CH = 45, CFPS = 10;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FSIZE = CW * CH;

/** Decode to fixed-size gray frames — rawvideo keeps the compare
 *  dependency-free (no png/jpeg decoder needed). */
const grayFrames = (file: string): Buffer =>
  execFileSync(FFMPEG, ['-v', 'error', '-i', file,
    '-vf', `fps=${CFPS},scale=${CW}:${CH}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 28 });

// Windowed SSIM (standard formula, C1/C2 from the paper at 0-255 range).
const W = 8, STRIDE = 2;
const C1 = 6.5025, C2 = 58.5225;
const frameSSIM = (a: Buffer, i: number, b: Buffer, j: number): number => {
  const oa = i * FSIZE, ob = j * FSIZE;
  let ssimSum = 0, nw = 0;
  for (let y = 0; y + W <= CH; y += STRIDE) {
    for (let x = 0; x + W <= CW; x += STRIDE) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let wy = 0; wy < W; wy++) {
        const ra = oa + (y + wy) * CW + x, rb = ob + (y + wy) * CW + x;
        for (let wx = 0; wx < W; wx++) {
          const va = a[ra + wx]!, vb = b[rb + wx]!;
          sa += va; sb += vb;
          saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const n = W * W;
      const mua = sa / n, mub = sb / n;
      const va = saa / n - mua * mua, vb = sbb / n - mub * mub;
      const cov = sab / n - mua * mub;
      ssimSum += ((2 * mua * mub + C1) * (2 * cov + C2)) /
                 ((mua * mua + mub * mub + C1) * (va + vb + C2));
      nw++;
    }
  }
  return nw ? ssimSum / nw : 0;
};

export interface VidDiff {
  segs: { lag: number; ssim: number }[];
  median: number; p5: number; frames: number;
}

export function vidcmp(livePath: string, replayPath: string, lagScan = 30, segSec = 2): VidDiff {
  const a = grayFrames(livePath), b = grayFrames(replayPath);
  const na = Math.floor(a.length / FSIZE), nb = Math.floor(b.length / FSIZE);
  const segLen = Math.max(1, Math.round(segSec * CFPS));
  console.log(`frames: live=${na} replay=${nb} @${CFPS}fps ${CW}x${CH}, segLen=${segLen}`);

  const segs: { lag: number; ssim: number }[] = [];
  for (let s0 = 0; s0 + segLen <= na; s0 += segLen) {
    let bestLag = 0, bestSsim = -1;
    for (let lag = -lagScan; lag <= lagScan; lag++) {
      let sum = 0, n = 0;
      for (let i = s0; i < s0 + segLen; i++) {
        const j = i + lag;
        if (j < 0 || j >= nb) continue;
        sum += frameSSIM(a, i, b, j);
        n++;
      }
      const mean = n ? sum / n : -1;
      if (mean > bestSsim) { bestSsim = mean; bestLag = lag; }
    }
    segs.push({ lag: bestLag, ssim: bestSsim });
  }
  const ss = segs.map(s => s.ssim).sort((x, y) => x - y);
  return {
    segs,
    median: ss[Math.floor(ss.length / 2)] ?? 0,
    p5: ss[Math.floor(ss.length * 0.05)] ?? 0,
    frames: na,
  };
}

// Standalone CLI
if (import.meta.main) {
  const [live, replay, lag, seg] = process.argv.slice(2);
  if (!live || !replay) {
    console.error('usage: bun _tools/e2e/vidcmp.ts live.mp4 replay.mp4 [lagScan] [segSec]');
    process.exit(1);
  }
  const r = vidcmp(live, replay, lag ? Number(lag) : 30, seg ? Number(seg) : 2);
  for (const [i, s] of r.segs.entries()) {
    console.log(`  seg ${i * 2}-${i * 2 + 2}s: lag ${s.lag > 0 ? '+' : ''}${s.lag}f ssim=${s.ssim.toFixed(3)}`);
  }
  console.log(`median=${r.median.toFixed(3)} p5=${r.p5.toFixed(3)} over ${r.segs.length} segs`);
}
