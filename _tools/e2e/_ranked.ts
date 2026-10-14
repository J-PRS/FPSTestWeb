import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { writeFileSync } from 'node:fs';

// Ranked-solo e2e — the full pipeline on a REAL run, no fixtures:
//   boot fetches /challenge from the spawned server → runSeed binds to
//   the minted seed → classic run records ~15s → demo submits through
//   POST /leaderboard/submit → server verifies sig + runSeed binding +
//   spawn-dice parity → ranked.
// ?server= only repoints the endpoint host — classic mode never joins
// a room (earlyWire requires ?room=), so ball spawning stays client-side.
const stack = await upStack();
const server = `127.0.0.1:${stack.serverPort}`;
const c = await launchClient(`http://localhost:5400/?mode=classic&bots=0&server=${server}`);
await c.waitFor(`window.__test && window.__test.demoManager`, 30_000);

// The challenge must bind before makeEntities — assert it did.
const bind = await c.page.evaluate(`(async () => {
  const ds = await import('/src/demo/demoSeed.ts');
  return { chal: ds.getChallenge(), runSeed: ds.getRunSeed() };
})()`);
if (!bind.chal) {
  console.log('FAIL — no challenge landed before entity boot');
  await closeClient(c); stack.down(); process.exit(1);
}
console.log(`challenge bound seed=0x${bind.chal.seed.toString(16)} runSeed=0x${bind.runSeed.toString(16)} match=${bind.chal.seed === bind.runSeed}`);

await new Promise((r) => setTimeout(r, 15_000));

// Pull the demo bytes AND the challenge the client will submit with.
const out = await c.page.evaluate(`(async () => {
  const dm = window.__test.demoManager;
  const f = dm.recorder.buildDemoFile();
  const { serializeDemo } = await import('/src/demo/demoWriter.js');
  const buf = new Uint8Array(serializeDemo(f));
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
  const ds = await import('/src/demo/demoSeed.ts');
  return { b64: btoa(s), chal: ds.getChallenge() };
})()`);
await closeClient(c);

const chalParam = `?chal=${btoa(JSON.stringify(out.chal))}`;
const res = await fetch(`http://${server}/leaderboard/submit${chalParam}`, {
  method: 'POST',
  body: Buffer.from(out.b64, 'base64'),
});
const body = await res.json();
console.log('SUBMIT', res.status, JSON.stringify(body).slice(0, 400));
const board = await (await fetch(`http://${server}/leaderboard?mode=classic`)).json();
console.log('BOARD', JSON.stringify(board).slice(0, 400));

writeFileSync('demos_out/ranked_solo.demo', Buffer.from(out.b64, 'base64'));
stack.down();
process.exit(body.ok && body.verdict === 'ranked' && body.entry?.attest === 'seed' ? 0 : 1);
