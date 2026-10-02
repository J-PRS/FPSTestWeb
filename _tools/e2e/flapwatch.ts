/**
 * flapwatch.ts — sit a real client in a room for 60s and record every
 * spontaneous disconnect/reconnect plus the server-side reason lines.
 *
 *   bun _tools/e2e/flapwatch.ts [seconds]
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const seconds = Number(process.argv[2] ?? 60);
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2eflap&bots=4'));

// Console capture — 'Disconnected'/'tier:'/'Connected as' land here.
const events: string[] = [];
client.page.on('console', (msg) => {
  const t = msg.text();
  if (/Disconnected|tier:|Connected as|reconnect|rtc|gameState/i.test(t)) {
    events.push(`${new Date().toISOString().slice(17, 23)} ${t}`);
  }
});

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  console.log(`connected — watching ${seconds}s`);
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await client.page.evaluate(`(() => ({
      conn: window.__test.networkManager.isConnected(),
      seq: window.__test.networkManager.lastTickSeq,
      tier: window.__test.networkManager.transportTier ?? null,
    }))()`).catch(() => null);
    if (s) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s connected=${s.conn} seq=${s.seq} tier=${s.tier}`);
  }
} finally {
  await closeClient(client);
  const log = stack.serverLog();
  const interesting = log.split('\n').filter(l => /disconnect|grace|kick|close|RTC|rtc|removePlayer|Player (left|joined)|claim/i.test(l));
  console.log('\n--- client events ---');
  console.log(events.join('\n') || '(none)');
  console.log('\n--- server log (filtered) ---');
  console.log(interesting.slice(-40).join('\n') || '(nothing relevant)');
  stack.down();
}
