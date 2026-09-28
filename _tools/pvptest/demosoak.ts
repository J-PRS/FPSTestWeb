/**
 * Demo endpoint soak — POST /demos/upload, GET /demos, GET /demos/:file.
 * Crafts a valid v2+ demo binary (magic 0x44 + header) and verifies:
 * accept above the lifetime floor, reject below, bad magic rejected,
 * path traversal rejected, download bytes round-trip.
 *
 * Usage: bun _tools/pvptest/demosoak.ts http://127.0.0.1:PORT
 */
const BASE = process.argv[2] ?? 'http://localhost:8000';
const FAIL = (m: string): never => { console.log('FAIL:', m); process.exit(1); };
const ok = (m: string) => console.log('ok —', m);

// Header layout mirrored from DemoStorage.parseDemoHeader.
function buildDemo(lifetime: number, desc = 'soak clip'): ArrayBuffer {
  const enc = new TextEncoder();
  const gv = enc.encode('0.0.0-soak');
  const d = enc.encode(desc);
  const buf = new ArrayBuffer(1 + 4 + 2 + gv.length + 8 + 5 * 4 + 2 + d.length + 32 + 4);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;
  v.setUint8(o++, 0x44);
  v.setInt32(o, 3, true); o += 4;
  v.setUint16(o, gv.length, true); o += 2;
  u8.set(gv, o); o += gv.length;
  v.setFloat64(o, Date.now(), true); o += 8;
  v.setFloat32(o, 5.0, true); o += 4;   // duration
  v.setFloat32(o, 100, true); o += 4;   // totalFrames
  v.setFloat32(o, 1, true); o += 4;     // projEventCount
  v.setFloat32(o, 0, true); o += 4;     // targetEventCount
  v.setFloat32(o, 0, true); o += 4;     // checksum
  v.setUint16(o, d.length, true); o += 2;
  u8.set(d, o); o += d.length;
  o += 32;                               // start pos/rot/vel
  v.setFloat32(o, lifetime, true);
  return buf;
}

const upload = async (body: ArrayBuffer, len?: number) =>
  fetch(`${BASE}/demos/upload`, {
    method: 'POST',
    headers: len ? { 'content-length': String(len) } : {},
    body,
  });

// reject bad magic
const bad = new ArrayBuffer(64); new DataView(bad).setUint8(0, 0x99);
const r0 = await upload(bad);
if (r0.status !== 500 && r0.status !== 400) FAIL(`bad magic → ${r0.status}`);
ok('bad magic rejected');

// reject below lifetime floor (0.2)
const low = await upload(buildDemo(0.05));
const lowJ = await low.json();
if (lowJ.success !== false || !lowJ.rejected) FAIL(`low-lifetime demo: ${JSON.stringify(lowJ)}`);
ok('below-threshold demo rejected');

// accept
const good = buildDemo(4.2);
const r1 = await upload(good);
const j1 = await r1.json();
if (!j1.success || !j1.filename) FAIL(`good demo: ${JSON.stringify(j1)}`);
ok(`accepted: ${j1.filename}`);

// list contains it
const list = await (await fetch(`${BASE}/demos`)).json();
if (!(list.demos ?? []).some((m: any) => m.filename === j1.filename)) FAIL('uploaded demo missing from /demos');
ok('/demos lists it');

// download round-trips byte-identical
const dl = await fetch(`${BASE}/demos/${j1.filename}`);
if (dl.status !== 200) FAIL(`download → ${dl.status}`);
const back = await dl.arrayBuffer();
if (back.byteLength !== good.byteLength) FAIL('download size mismatch');
ok('download round-trips');

// traversal + missing rejected
if ((await fetch(`${BASE}/demos/..%2Findex.json`)).status !== 404) FAIL('traversal not 404');
if ((await fetch(`${BASE}/demos/nope.demo`)).status !== 404) FAIL('missing demo not 404');
if ((await fetch(`${BASE}/demos/upload`)).status !== 404) FAIL('GET upload not 404');
ok('traversal/missing/GET-upload all 404');

console.log('PASS: demo endpoints verified');
process.exit(0);
