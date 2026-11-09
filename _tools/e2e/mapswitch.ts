/**
 * mapswitch.ts — in-place map-change latency benchmark (regression guard).
 *
 *   bun _tools/e2e/mapswitch.ts [room...]
 *
 * Joins the first room, then hops room->room with `switchRoom()` and times
 * how long the CLIENT takes to build the new map: from the switch send to
 * `world.onTerrainApplied` (the exact point applyTerrain finishes the field
 * swap + material re-key). Every target below has a DISTINCT heightfield so
 * the swap can't dedupe away, and a frame-gap watchdog catches a main-thread
 * stall (a hung/wedged tab) separately from plain slowness.
 *
 * Budget is deliberately generous for SwiftShader headless; a real
 * regression shows up as a number, not a flake. Override with
 * MAPSWITCH_BUDGET_MS.
 */
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const BUDGET_MS = Number(process.env.MAPSWITCH_BUDGET_MS ?? 6000);
const STALL_MS = Number(process.env.MAPSWITCH_STALL_MS ?? 2500);
// Distinct terrain bins, so every hop forces a real field swap.
const CHAIN = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['whiteout', 'hills', 'caldera', 'rimrock', 'lagoon', 'dunes'];

interface Hop { room: string; sent: boolean; ok: boolean; timedOut: boolean; ms: number; appliedFile: string | null; maxGapMs: number; frames: number; before?: string }

function hopExpr(room: string): string {
  return `(async () => {
    const t = window.__test;
    const before = t.world.mapName;
    const prev = t.world.onTerrainApplied;
    let appliedAt = 0, appliedFile = null;
    const applied = new Promise((res) => {
      t.world.onTerrainApplied = (file) => {
        appliedAt = performance.now(); appliedFile = file;
        try { if (prev) prev(file); } catch (e) { /* keep prev semantics best-effort */ }
        res();
      };
    });
    let last = performance.now(), maxGap = 0, frames = 0, raf = 0;
    const tick = () => { const n = performance.now(); const g = n - last; if (g > maxGap) maxGap = g; last = n; frames += 1; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    // A hop that fires while the socket is mid-reconnect returns false and
    // never leaves the client - the whole wait then measures nothing. Retry
    // the send once after a beat instead of scoring a phantom timeout.
    let sent = t.networkManager.switchRoom(${JSON.stringify(room)});
    if (!sent) { await new Promise((r) => setTimeout(r, 2000)); sent = t.networkManager.switchRoom(${JSON.stringify(room)}); }
    let timedOut = false;
    await Promise.race([
      applied,
      new Promise((r) => setTimeout(() => { timedOut = true; r(); }, ${BUDGET_MS + 4000})),
    ]);
    cancelAnimationFrame(raf);
    t.world.onTerrainApplied = prev;
    const ms = Math.round((appliedAt || performance.now()) - t0);
    return { room: ${JSON.stringify(room)}, sent, ok: appliedAt > 0, timedOut, ms, appliedFile, maxGapMs: Math.round(maxGap), frames, before };
  })()`;
}

const stack = await upStack();
const first = CHAIN[0]!;
const client = await launchClient(stack.clientUrl(`&room=${first}&bots=0&net=ws`));
const hops: Hop[] = [];
let failed = 0;

try {
  await client.waitFor('t.player && t.player.pos', 30000);
  // Let the boot map finish applying before we start timing hops.
  await client.page.evaluate(`new Promise((res) => {
    const t = window.__test;
    if (!t.world.mapName) { const p = t.world.onTerrainApplied; t.world.onTerrainApplied = (f) => { if (p) p(f); res(); }; setTimeout(res, 12000); }
    else res();
  })`);
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`\nmap-switch latency (budget ${BUDGET_MS}ms, stall ${STALL_MS}ms)\n`);
  for (let i = 1; i < CHAIN.length; i += 1) {
    const hop = await client.page.evaluate(hopExpr(CHAIN[i]!)) as Hop;
    hops.push(hop);
    const flag = !hop.ok || hop.timedOut ? 'FAIL' : hop.ms > BUDGET_MS ? 'SLOW' : 'ok  ';
    console.log(`  ${flag} ${hop.before ?? '?'} -> ${hop.room.padEnd(9)} state@${String(hop.ms).padStart(5)}ms  field=${String(hop.appliedFile).padEnd(10)} frames=${hop.frames} maxGap=${hop.maxGapMs}ms${hop.sent ? '' : ' UNSENT'}`);
    if (!hop.ok || hop.timedOut || hop.ms > BUDGET_MS || hop.maxGapMs > STALL_MS) failed += 1;
    // Space the hops out — the server's join-flood guard drops rapid re-joins.
    await new Promise((r) => setTimeout(r, 1500));
  }

  const ms = hops.filter((h) => h.ok).map((h) => h.ms).toSorted((a, b) => a - b);
  const median = ms.length ? ms[Math.floor(ms.length / 2)] : -1;
  const max = ms.length ? ms[ms.length - 1] : -1;
  console.log(`\n  ${hops.length} hops · median ${median}ms · max ${max}ms · ${hops.length - failed} ok, ${failed} failed\n`);
  if (failed && process.env.MAPSWITCH_DEBUG) {
    console.log('--- server log tail ---');
    console.log(stack.serverLog().split('\n').slice(-80).join('\n'));
  }
} finally {
  await closeClient(client);
  stack.down();
}

process.exit(failed ? 1 : 0);
