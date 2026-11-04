// Ball-kill closeup: record a classic (ball-only) demo, find a ball
// Destroyed edge, replay to it, park the camera at the kill point and
// screenshot before/during/after — proves the ball is visible at death.
// bun _tools/e2e/_killshot.ts [recordSecs]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';

const secs = Number(process.argv[2] ?? 20);
const stack = await upStack();
let c: Awaited<ReturnType<typeof launchClient>> | null = null;
try {
  // TRUE offline (no server): the client owns ball spawning — connected
  // mode hands it to the wire and spawnBall() silently no-ops.
  c = await launchClient(`http://localhost:${stack.clientPort}/?mode=classic&bots=0&autopilot`);
  await c.waitFor(`window.__test && window.__test.demoManager`, 45000);
  await new Promise(r => setTimeout(r, 4000));
  // Nobody shoots balls in classic bots=0 — force a kill through the real
  // death path so the clip carries a Destroyed edge to aim the camera at.
  const dbg = await c.page.evaluate(`(async () => {
    const t = window.__test;
    for (let i = 0; i < 4; i++) {t.entities.spawnBall();}
    return { rec: t.demoManager?.isRecording, dm: !!t.demoManager, balls: t.entities.balls?.length, keys: Object.keys(t.entities).slice(0, 30) };
  })()`);
  console.log('dbg', JSON.stringify(dbg));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.evaluate(`(() => {
    const b = (window.__test.entities.balls ?? [])[0];
    if (b) {b.takeDamage(9999);}
  })()`);
  await new Promise(r => setTimeout(r, secs * 1000));
  const out = await c.page.evaluate(`(async () => {
    const dm = window.__test.demoManager;
    const f = dm.recorder.buildDemoFile('killshot');
    // find the last ball Destroyed/Hit-to-0 edge (targetType < 32 = ball lane)
    let kill = null;
    for (const e of f.targetEvents) {
      if (e.targetType < 32 && (e.eventType === 3 || (e.eventType === 2 && e.health <= 0))) {kill = e;}
    }
    if (!kill) {
      for (const e of f.targetEvents) {if (e.targetType < 32) {kill = e;}} // any ball edge
    }
    const { serializeDemo } = await import('/src/demo/demoWriter.js');
    const buf = new Uint8Array(serializeDemo(f));
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
    return { b64: btoa(s), kill, dur: f.header.duration };
  })()`) as { b64: string; kill: { timestamp: number; posX: number; posY: number; posZ: number } | null; dur: number };
  if (!out.kill) {throw new Error('no ball edges in clip — needs longer record');}
  console.log(`kill edge @t=${out.kill.timestamp.toFixed(2)} pos=(${out.kill.posX.toFixed(0)},${out.kill.posY.toFixed(0)},${out.kill.posZ.toFixed(0)})`);

  // Reload the SAME page into playback of that clip, seek to the kill.
  await c.page.evaluate(`(async (b64) => {
    const bin = atob(b64); const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {buf[i] = bin.charCodeAt(i);}
    const { deserializeDemo } = await import('/src/demo/demoReader.js');
    const dm = window.__test.demoManager;
    dm.player.load(deserializeDemo(buf.buffer));
    dm.mode = 'playing'; dm.player.play();
    // Free the camera: playback POV otherwise rewrites position every
    // frame and the parked cam never sticks.
    const pl = window.__test.player;
    if (pl.toggleSpectator) {pl.toggleSpectator();}
    window.__killcam = true;
  })(${JSON.stringify(out.b64)})`);
  await new Promise(r => setTimeout(r, 1500)); // playback world builds

  const KT = out.kill.timestamp;
  for (const [i, t] of [[0, KT - 0.12], [1, KT], [2, KT + 0.35]] as const) {
    await c.page.evaluate(`(async (t, px, py, pz) => {
      const dm = window.__test.demoManager;
      dm.player.pause();
      dm.player.seek(t);
      dm.onRemotePlayback?.(dm.player.getRemoteStates(), 0);
      // Report the playback replica's live state — is the ball even in the world?
      const cands = [window.__test.demoLifecycle, window.__test.demoLifecycle?.d,
        window.__test.world, window.__test.demoManager?.player];
      const map = cands.map((o) => o?.playbackBallById).find(Boolean) ?? new Map();
      const pb = [...map.values()];
      const b = pb[0];
      window.__dbg = { n: pb.length, pos: b ? [b.pos.x, b.pos.y, b.pos.z] : null,
        dead: b?.dead, meshRemoved: b?.meshRemoved, slot: b?.swarmSlot, scale: b?.scale };
      // Camera: third-person of the ball — 7m behind + 2m above its LIVE pos.
      const cam = window.__test.getCamera?.() ?? window.__camera;
      const at = b ? b.pos : { x: px, y: py, z: pz };
      if (cam) {
        cam.position.set(at.x + 5, at.y + 2, at.z + 5);
        cam.lookAt(at.x, at.y, at.z);
      } else {console.log('no camera handle found');}
    })(${t}, ${out.kill.posX}, ${out.kill.posY}, ${out.kill.posZ})`);
    await new Promise(r => setTimeout(r, 400));
    mkdirSync('screenshots', { recursive: true });
    await c.page.screenshot({ path: `screenshots/kill_${i}.png` });
    const dbg = await c.page.evaluate('window.__dbg');
    console.log(`wrote screenshots/kill_${i}.png (t=${t.toFixed(2)}) pbBalls=${JSON.stringify(dbg)}`);
  }
} finally {
  if (c) {await closeClient(c);}
  await stack.down();
}
