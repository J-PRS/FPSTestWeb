/**
 * duo.ts — two-client E2E: two real Chrome clients in the same room.
 *
 *   bun _tools/e2e/duo.ts
 *
 * Asserts real multiplayer on the real wire:
 *   1. both clients connect + seat in the same room
 *   2. each sees the OTHER in world.remotePlayers
 *   3. A moves; B watches A's remote position track the motion
 *   4. A's chat lands in B's feed; team-scoped chat from A doesn't
 *      reach a same-team? (ffa room → team falls back to global, so
 *      instead assert global round-trip both ways)
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
// bots=0 — no server bots, so a counted 'teleport' message can only be
// A's declared warp (bot spawns would pollute the tpSeen counter).
const url = stack.clientUrl('&room=e2eduo&bots=0');
const [a, b] = await Promise.all([launchClient(url), launchClient(url)]);

try {
  for (const c of [a, b]) {
    await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
    await c.waitFor(`t.networkManager.lastTickSeq >= 0`, 20000);
  }
  ok(true, 'both clients connected and seated');

  // Each sees the other (plus any server bots) — find the peer by id.
  const aId = await a.test<string>(`t.networkManager.localPlayerId`);
  const bId = await b.test<string>(`t.networkManager.localPlayerId`);
  console.log(`   (peers: a=${aId} b=${bId})`);
  await a.waitFor(`t.world.remotePlayers.entities.has('${bId}')`, 20000).catch(() => null);
  await b.waitFor(`t.world.remotePlayers.entities.has('${aId}')`, 20000).catch(() => null);
  const aSeesB = await a.test<boolean>(`t.world.remotePlayers.entities.has('${bId}')`);
  const bSeesA = await b.test<boolean>(`t.world.remotePlayers.entities.has('${aId}')`);
  ok(aSeesB && bSeesA, `mutual visibility (a→b=${aSeesB} b→a=${bSeesA})`);

  // A teleports a modest hop; B's wire snapshot of A must track it — proves
  // real position propagation, not just presence. Kept inside B's interest
  // radius on purpose: a 500m+ jump leaves the position-record radius, so
  // B legitimately keeps a stale target (only the event arrives). Count
  // teleport msgs to distinguish "event never arrived" from "entity didn't
  // snap".
  await b.page.evaluate(`(() => { const nm = window.__test.networkManager; const orig = nm.onRemoteTeleport; window.__tpSeen = 0; nm.onRemoteTeleport = (...args) => { window.__tpSeen++; orig?.(...args); }; })()`);
  const bx0 = await b.test<number>(`(t.world.remotePlayers.entities.get('${aId}')?.position?.x) ?? 1e9`);
  // The REAL warp path: set pos → syncMovement (reseats the controller so
  // the sim doesn't revert next frame) → markTeleport — the next position
  // report then emits the 'teleport' verb. Bare sendTeleport only DECLARES
  // a warp; the player's real pos stays put and the judge corrects them
  // back (verified: aPos stayed ~80 while B saw the stale 79).
  const tp = await a.test<{ x: number; z: number }>(`(() => {
    const p = t.player;
    const dest = { x: p.pos.x + 25, y: 60, z: p.pos.z };
    p.pos.set(dest.x, dest.y, dest.z);
    p.vel.set(0, 0, 0);
    p.syncMovement();
    p.markTeleport();
    return { x: dest.x, z: dest.z };
  })()`);
  await b.waitFor(`Math.abs((t.world.remotePlayers.entities.get('${aId}')?.position?.x ?? 0) - ${tp.x}) < 5`, 20000).catch(() => null);
  const bx1 = await b.test<number>(`(t.world.remotePlayers.entities.get('${aId}')?.position?.x) ?? 0`);
  const tpSeen = await b.test<number>(`window.__tpSeen`);
  ok(Math.abs(bx1 - tp.x) < 5, `A's teleport propagated to B (x: ${bx0.toFixed(0)} → ${bx1.toFixed(0)}, target ${tp.x.toFixed(0)}, teleport msgs seen: ${tpSeen})`);
  if (Math.abs(bx1 - tp.x) >= 5) {
    // Diagnostics: is A's server pos actually at the warp site, and is B's
    // entity just frozen (records suppressed) or still tracking stale data?
    const aPos = await a.test(`(() => { const p = t.player.pos; return {x:p.x,y:p.y,z:p.z}; })()`);
    console.log(`   diag: aPos=${JSON.stringify(aPos)} metrics=${JSON.stringify(await stack.serverMetrics())}`);
    console.log(`   srvlog tail:\n${stack.serverLog().split('\n').slice(-30).join('\n')}`);
  }

  // Chat both directions on the real wire — capture at onChat (the raw
  // receive path; DOM fades make feed polling flaky under SwiftShader).
  for (const c of [a, b]) {
    await c.page.evaluate(`(() => { const nm = window.__test.networkManager; const orig = nm.onChat; window.__chatLog = []; nm.onChat = (id, text, team) => { window.__chatLog.push({ from: id, text, team }); orig?.(id, text, team); }; })()`);
  }
  await a.page.evaluate(`window.__test.networkManager.send({ type: 'chat', text: 'hello from A' })`);
  await b.page.evaluate(`window.__test.networkManager.send({ type: 'chat', text: 'hello from B' })`);
  // Under SwiftShader + machine load, wall-clock timeouts are ~7x
  // tighter in game time — 30s is still only a few seconds of sim.
  const [bHeard, aHeard] = await Promise.all([
    b.waitFor(`window.__chatLog?.some(l => l.text === 'hello from A')`, 30000).then(() => true).catch(() => false),
    a.waitFor(`window.__chatLog?.some(l => l.text === 'hello from B')`, 30000).then(() => true).catch(() => false),
  ]);
  ok(bHeard && aHeard, `chat both directions (a→b=${bHeard} b→a=${aHeard})`);

  // Zero corrections on either client for the whole session
  const corrA = await a.test<number>(`window.__corrCount ?? 0`).catch(() => -1);
  const corrB = await b.test<number>(`window.__corrCount ?? 0`).catch(() => -1);
  console.log(`   (correction counters: a=${corrA} b=${corrB} — not instrumented, informational)`);
} finally {
  await Promise.all([closeClient(a), closeClient(b)]);
  stack.down();
}

console.log(failures === 0 ? '\nDUO: ALL PASS' : `\nDUO: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
