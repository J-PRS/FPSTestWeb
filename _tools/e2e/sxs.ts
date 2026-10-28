/**
 * sxs.ts — one-shot demo→mp4 render + side-by-side stack.
 *
 *   bun _tools/e2e/sxs.ts clip.demo [live.mp4] [out.mp4]
 *   bun _tools/e2e/sxs.ts clip.demo --fps=30 --size=1280x720
 *
 * Renders the demo through demorender (authored-timestamp scrub, exact
 * demo-clock window), then hstack's it against the live capture when
 * one is given — the "play, score a shot, compare" workflow without the
 * multi-step plumbing. No live mp4 → just the replay render.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = `${REPO}_tools/e2e/shots`;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--'));
const opts = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  }),
);

if (pos.length === 0) {
  console.error('usage: bun sxs.ts <file.demo> [live.mp4] [out.mp4] [--fps=30] [--size=1280x720] [--crf=19]');
  process.exit(1);
}

const demo = pos[0]!;
const liveMp4 = pos[1] ?? null;
const stem = basename(demo).replace(/\.demo$/, '');
const outMp4 = pos[2] ?? join(OUT, `${stem}-sxs.mp4`);
const replayMp4 = join(OUT, `${stem}-replay.mp4`);

mkdirSync(OUT, { recursive: true });

// Probe the live clip first — the replay renders at ITS size+fps so the
// stack is a fair pixel-for-pixel compare, not an upscale.
const probe = (f: string): { w: number; h: number; fps: number } => {
  const j = JSON.parse(execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', f,
  ]).toString());
  const s = j.streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  return { w: s.width, h: s.height, fps: n / d };
};
const lp = liveMp4 ? probe(liveMp4) : null;
const size = opts.size ?? (lp ? `${lp.w}x${lp.h}` : '1280x720');
const fps = opts.fps ?? (lp ? Math.round(lp.fps) : 30);

// Render the demo — authored-timestamp scrub, exact demo window, live
// post chain on (--post) so the grade matches a real capture.
console.log(`render ${demo} → ${replayMp4} @${size} ${fps}fps post`);
const r = spawnSync('node', [
  `${REPO}_tools/demorender/render.js`, demo, replayMp4,
  `--fps=${fps}`, `--size=${size}`, '--post',
], { stdio: 'inherit', env: { ...process.env, E2E_GPU: '1' } });
if (r.status !== 0 || !existsSync(replayMp4)) {
  console.error('render failed');
  process.exit(1);
}

if (!liveMp4) {
  console.log(`DONE ${replayMp4}`);
  process.exit(0);
}

// Stack live|replay at half-width each.
const half = 960;
console.log(`stack ${liveMp4} + ${replayMp4} → ${outMp4} @${lp.fps}fps`);
execFileSync(FFMPEG, [
  '-y', '-i', liveMp4, '-i', replayMp4,
  '-filter_complex',
  `[0:v]scale=${half}:-1,drawtext=text='LIVE':x=20:y=20:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6[l];` +
  `[1:v]scale=${half}:-1,drawtext=text='REPLAY':x=20:y=20:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6[r];` +
  `[l][r]hstack`,
  '-c:v', 'libx264', '-crf', String(opts.crf ?? 20), '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-shortest', outMp4,
], { stdio: 'inherit' });
console.log(`DONE ${outMp4}`);
