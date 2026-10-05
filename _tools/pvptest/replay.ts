// Offline replay — feeds a .rec capture through the real wire decoder.
// Regression check: every binary frame must decode; reports throughput.
// Usage: bun replay.ts <capture.rec>
import { readFileSync } from 'node:fs';
import { isWireFrame, decodeTickFrame, WIRE_TICK, WIRE_TICK_V1, WIRE_TICK_V3, WireIdRoster } from '../../shared/wire.ts';
const wireRoster = new WireIdRoster();

const file = process.argv[2];
if (!file) { console.error('usage: bun replay.ts <capture.rec>'); process.exit(1); }

let frames = 0, records = 0, bytes = 0, undecodable = 0, jsons = 0;
let maxFrameUs = 0, decodeUs = 0;
const t0 = performance.now();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  const tab1 = line.indexOf('\t');
  const tab2 = line.indexOf('\t', tab1 + 1);
  const kind = line.slice(tab1 + 1, tab2);
  const payload = line.slice(tab2 + 1);
  if (kind === 'json') { jsons++; try { wireRoster.feed(JSON.parse(payload)); } catch { /* unrelated json */ } continue; }
  const u8 = new Uint8Array(Buffer.from(payload, 'hex'));
  bytes += u8.byteLength;
  if (!isWireFrame(u8) || (u8[1] !== WIRE_TICK && u8[1] !== WIRE_TICK_V1 && u8[1] !== WIRE_TICK_V3)) continue;
  frames++;
  const s = performance.now();
  const f = decodeTickFrame(u8, wireRoster.pool);
  const us = (performance.now() - s) * 1000;
  decodeUs += us;
  if (us > maxFrameUs) maxFrameUs = us;
  if (!f) { undecodable++; continue; }
  records += f.count;
}
const wallMs = performance.now() - t0;
console.log(`${file}: ${frames} tick frames / ${records} records / ${bytes}B / ${jsons} json`);
console.log(`decode: total ${decodeUs.toFixed(0)}us, avg ${(decodeUs / Math.max(1, frames)).toFixed(1)}us/frame, max ${maxFrameUs.toFixed(0)}us — wall ${wallMs.toFixed(0)}ms`);
if (undecodable) { console.error(`FAIL: ${undecodable} undecodable frames`); process.exit(1); }
console.log('PASS: all frames decodable');
