/**
 * duo_p2p.ts — friend-play E2E: two real clients over the WebRTC p2p tier.
 *
 *   bun _tools/e2e/duo_p2p.ts
 *
 * Host opens ?p2p=host:CODE (runs the real server modules in-page),
 * guest opens ?p2p=join:CODE (connects via the /rtc handshake relay on
 * the same bun server). Asserts: guest connects, both see each other in
 * remotePlayers, positions stream, chat crosses the DataChannel.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const ROOM = 'e2ep2p';
const stack = await upStack();
const host = await launchClient(stack.clientUrl(`&p2p=host:${ROOM}`));
const guest = await launchClient(stack.clientUrl(`&p2p=join:${ROOM}`));

try {
  // Host runs the sim in-page; guest joins through the /rtc relay.
  await host.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await guest.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);

  const hostId = await host.test<string>(`t.networkManager.localPlayerId`);
  const guestId = await guest.test<string>(`t.networkManager.localPlayerId`);
  console.log(`host=${hostId} guest=${guestId} tier=${await guest.test(`t.networkManager.getTransportTier()`)}`);

  await guest.waitFor(`t.world.remotePlayers.entities.has('${hostId}')`, 25000);
  check(true, 'guest sees host in remotePlayers');
  await host.waitFor(`t.world.remotePlayers.entities.has('${guestId}')`, 25000);
  check(true, 'host sees guest in remotePlayers');

  // Spy before moving so we can tell message-arrival from entity-update.
  await guest.page.evaluate(`(() => {
    const nm = window.__test.networkManager;
    window.__tpSeen = 0;
    const orig = nm.onRemoteTeleport?.bind(nm);
    nm.onRemoteTeleport = (id, p, v) => { window.__tpSeen++; orig?.(id, p, v); };
  })()`);

  // Move the host's own player — the REAL warp path: set pos →
  // syncMovement (keep the sim from reverting) → markTeleport; the next
  // position report emits the 'teleport' verb. Bare sendTeleport only
  // declares a warp without moving the player.
  await host.test(`(() => {
    const p = t.player;
    p.pos.set(500, 60, 500); p.vel.set(0, 0, 0);
    p.syncMovement(); p.markTeleport();
  })()`);
  let streamed = false;
  try {
    await guest.waitFor(
      `Math.abs(t.world.remotePlayers.entities.get('${hostId}')?.position.x - 500) < 1`,
      25000,
    );
    streamed = true;
  } catch { /* fall through to diagnostics */ }
  const tpSeen = await guest.test<number>(`window.__tpSeen ?? -1`);
  const hostPos = await guest.test(`t.world.remotePlayers.entities.get('${hostId}')?.position`);
  check(streamed, `host position streams to guest (tpSeen=${tpSeen} pos=${JSON.stringify(hostPos)})`);

  // Chat crosses the DataChannel both ways.
  const capture = (label: string) => `(async () => {
    const nm = window.__test.networkManager;
    window.__chatLog = window.__chatLog || [];
    const orig = nm.onChat?.bind(nm);
    nm.onChat = (id, text, team) => { window.__chatLog.push({ id, text, team }); orig?.(id, text, team); };
  })()`;
  await host.page.evaluate(capture('host'));
  await guest.page.evaluate(capture('guest'));

  await host.test(`t.networkManager.send({type:'chat', text:'hello from host', team:false})`);
  await guest.test(`t.networkManager.send({type:'chat', text:'hello from guest', team:false})`);

  const heard = async (who: 'guest' | 'host', text: string): Promise<boolean> => {
    const c = who === 'guest' ? guest : host;
    try { await c.waitFor(`window.__chatLog?.some(l => l.text === '${text}')`, 20000); return true; }
    catch { return false; }
  };
  check(await heard('guest', 'hello from host'), `guest receives host chat (log: ${JSON.stringify(await guest.test(`window.__chatLog`))})`);
  check(await heard('host', 'hello from guest'), `host receives guest chat (log: ${JSON.stringify(await host.test(`window.__chatLog`))})`);

  // One-world check: the guest must live in the HOST's map, not its own
  // saved one — gameState carries the host's terrain, and a mismatch
  // means two clients simming different ground. Sample a spread of
  // world points and require identical heights on both ends.
  const samples = [[0, 0], [500, 500], [-300, 120], [777, -222]];
  const hostHeights = await host.test<number[]>(`[${samples.map(([x, z]) => `t.terrain.getHeight(${x},${z})`).join(',')}]`);
  const guestHeights = await guest.test<number[]>(`[${samples.map(([x, z]) => `t.terrain.getHeight(${x},${z})`).join(',')}]`);
  const drift = Math.max(...hostHeights.map((h, i) => Math.abs(h - (guestHeights[i] ?? NaN))));
  check(drift < 0.5, `guest terrain matches host map (max drift ${drift.toFixed(3)}m over ${samples.length} samples)`);
} finally {
  await closeClient(host);
  await closeClient(guest);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
