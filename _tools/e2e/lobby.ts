/**
 * lobby.ts — open-lobby quick-join E2E.
 *
 *   bun _tools/e2e/lobby.ts
 *
 * Host marks its room public (?p2p=host:CODE&lobby); /rtc/lobbies lists
 * it while it waits; a second client with ?p2p=quick discovers and joins
 * it — no room code ever exchanged.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const stack = await upStack();
const host = await launchClient(stack.clientUrl(`&p2p=host:e2elobby&lobby`));

try {
  await host.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  const hostId = await host.test<string>(`t.networkManager.localPlayerId`);

  // The relay lists the open room while it's waiting on a guest.
  let listed: { room: string; since: number }[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://localhost:${stack.serverPort}/rtc/lobbies`).then((r) => r.json()).catch(() => []);
    if ((res as { room: string }[]).some((l) => l.room === 'e2elobby')) { listed = res; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  check(listed.some((l) => l.room === 'e2elobby'), `/rtc/lobbies lists open room (${JSON.stringify(listed)})`);

  // Quick-joiner never sees a code — it asks the relay for the lobby.
  const guest = await launchClient(stack.clientUrl(`&p2p=quick`));
  try {
    await guest.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);
    check(true, 'quick-join client connected');
    await guest.waitFor(`t.world.remotePlayers.entities.has('${hostId}')`, 25000);
    check(true, 'quick-joiner sees host');
    await host.waitFor(`t.world.remotePlayers.entities.size >= 1`, 25000);
    check(true, 'host sees quick-joiner');

    // Once paired, the room leaves the lobby list.
    const res = await fetch(`http://localhost:${stack.serverPort}/rtc/lobbies`).then((r) => r.json()).catch(() => []);
    check(!(res as { room: string }[]).some((l) => l.room === 'e2elobby'), 'paired room unlisted from lobbies');
  } finally {
    await closeClient(guest);
  }
} finally {
  await closeClient(host);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
