/**
 * smoke.ts — single-client E2E: real Chrome client vs real Bun server.
 *
 *   bun _tools/e2e/smoke.ts
 *
 * Asserts (all through the real client binary, not a simulated bot):
 *   1. connect + handshake → gameState lands (isConnected, room seated)
 *   2. binary tick frames arrive and tickSeq advances
 *   3. server-seeded bots appear in world.remotePlayers and MOVE
 *   4. no server corrections on an idle client
 *   5. a fired shot is accepted server-side (no rejection spike)
 *   6. chat round-trips the real wire (feed shows own line)
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
const client = await launchClient(stack.clientUrl('&room=e2esmoke&bots=4'));

try {
  // 1. connect + seat
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`t.networkManager.lastTickSeq >= 0`, 20000);
  ok(true, 'client connected and received gameState');

  // 2. tick frames advancing
  const seq0 = await client.test<number>(`t.networkManager.lastTickSeq`);
  await sleep(2500);
  const seq1 = await client.test<number>(`t.networkManager.lastTickSeq`);
  ok(seq1 > seq0, `binary tick frames advancing (seq ${seq0} → ${seq1})`);

  // 3. remote bots visible and moving
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  ok(remotes >= 1, `${remotes} server bot(s) in remotePlayers`);

  // Corrections counter — handleCorrection only logs; wrap to count.
  await client.page.evaluate(`(() => { const nm = window.__test.networkManager; const orig = nm.handleCorrection.bind(nm); window.__corrCount = 0; nm.handleCorrection = (d) => { window.__corrCount++; orig(d); }; })()`);
  const pos0 = await client.test<number[]>(`[...t.world.remotePlayers.entities.values()].map(e => e.targetPosition ? e.targetPosition.x : e.position.x)`);
  await sleep(2000);
  const pos1 = await client.test<number[]>(`[...t.world.remotePlayers.entities.values()].map(e => e.targetPosition ? e.targetPosition.x : e.position.x)`);
  ok(pos0.some((p, i) => Math.abs(p - pos1[i]!) > 0.01), 'remote positions updating from wire');

  // 4. zero server corrections on an honest idle client
  const corr = await client.test<number>(`window.__corrCount`);
  ok(corr === 0, `zero server corrections (got ${corr})`);

  // 5. fire a shot — real input path (pointer-lock stubbed)
  await client.page.evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }))`);
  await sleep(300);
  await client.page.evaluate(`document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))`);
  await sleep(1200);
  const m = await stack.serverMetrics();
  ok((m.msgsRejected ?? 0) === 0, `no server-side rejections (msgsRejected=${m.msgsRejected})`);

  // 6. chat round-trip on the real wire — capture at onChat (DOM feed
  // lines fade on a timer; polling them can miss under SwiftShader)
  await client.page.evaluate(`(() => { const nm = window.__test.networkManager; const orig = nm.onChat; window.__chatLog = []; nm.onChat = (id, text, team) => { window.__chatLog.push({ from: id, text, team }); orig?.(id, text, team); }; })()`);
  await client.page.evaluate(`window.__test.networkManager.send({ type: 'chat', text: 'e2e ping' })`);
  const chatSeen = await client.waitFor(`window.__chatLog?.some(l => l.text === 'e2e ping')`, 8000).then(() => true).catch(() => false);
  ok(chatSeen, 'chat line round-tripped the wire');

  const tier = await client.test(`t.networkManager.getTransportTier()`);
  console.log(`   (primary tier: ${tier})`);

  // 7. forced-ws leg: the tiered probe prefers wt in this env, so without
  // pinning ?net=ws the plain socket path would go untested by the suite.
  // Own room + own bots: the primary client can drop while the second
  // headless Chrome spawns (CPU spike kills wt sessions), and sharing a
  // room would leave this client alone in a recreated empty one.
  const wsClient = await launchClient(stack.clientUrl('&room=e2esmoke-ws&bots=2&net=ws'));
  try {
    await wsClient.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
    const wsTier = await wsClient.test<string>(`t.networkManager.getTransportTier()`);
    ok(wsTier === 'ws', `forced ws tier negotiated (got ${wsTier})`);
    const w0 = await wsClient.test<number>(`t.networkManager.lastTickSeq`);
    await sleep(2000);
    const w1 = await wsClient.test<number>(`t.networkManager.lastTickSeq`);
    ok(w1 > w0, `ws tick frames advancing (${w0} → ${w1})`);
    await wsClient.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000)
      .catch(() => null);
    const wsRoster = await wsClient.test<number>(`t.world.remotePlayers.entities.size`);
    ok(wsRoster >= 1, `ws client sees server bot(s) (${wsRoster})`);
  } finally {
    await closeClient(wsClient);
  }
} finally {
  await closeClient(client);
  stack.down();
}

console.log(failures === 0 ? '\nSMOKE: ALL PASS' : `\nSMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
