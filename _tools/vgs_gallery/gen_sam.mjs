// SAM (sam-js) VGS gallery renderer — PCM → WAV per line per voice preset.
// Run: node gen_sam.mjs   (bun works too)
import { createRequire } from 'module';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const SamJs = require('../../client/node_modules/sam-js/dist/samjs.common.js');
const Sam = SamJs.default ?? SamJs;

const here = dirname(fileURLToPath(import.meta.url));
const LINES_FILE = process.env.LINES ?? 'lines.json';
const OUT = process.env.OUT ?? 'out';
const lines = JSON.parse(readFileSync(join(here, LINES_FILE), 'utf8')).lines;

// Same preset table as client/src/core/tts.ts — keep in sync.
const VOICES = [
  { name: 'stock',    pitch: 64, speed: 72, mouth: 128, throat: 128 },
  { name: 'lowbuzz',  pitch: 48, speed: 74, mouth: 150, throat: 110 },
  { name: 'reedy',    pitch: 82, speed: 70, mouth: 110, throat: 150 },
  { name: 'throaty',  pitch: 56, speed: 78, mouth: 128, throat: 170 },
  { name: 'tinny',    pitch: 90, speed: 80, mouth: 140, throat: 120 },
  { name: 'gravel',   pitch: 40, speed: 66, mouth: 160, throat: 140 },
  { name: 'clipped',  pitch: 72, speed: 76, mouth: 100, throat: 100 },
  { name: 'wide',     pitch: 60, speed: 70, mouth: 170, throat: 128 },
];
const RATE = 22050;
const ONLY = process.env.VOICES ? process.env.VOICES.split(',') : null;

function wav(pcm) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

let n = 0;
for (const v of VOICES) {
  if (ONLY && !ONLY.includes(v.name)) {continue;}
  const sam = new Sam({ pitch: v.pitch, speed: v.speed, mouth: v.mouth, throat: v.throat });
  const dir = join(here, OUT, `sam-${v.name}`);
  mkdirSync(dir, { recursive: true });
  for (const l of lines) {
    const out = join(dir, `${l.chord}.wav`);
    if (existsSync(out)) {continue;}
    const text = (l.alt && l.alt.sam) || l.text;
    const pcm = sam.buf32(text.replace(/!/g, ''));
    if (!(pcm instanceof Float32Array) || !pcm.length) { console.log(`SKIP ${v.name}/${l.chord}`); continue; }
    writeFileSync(out, wav(pcm));
    n++;
  }
}
console.log(`wrote ${n} sam wavs`);
