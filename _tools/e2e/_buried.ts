import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

// remote-buried correlator: client glitches print via console.error;
// the server-side unbury rescue log lives in the rolling serverLog tail.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=buried-0&bots=10&mode=ctf'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000);
await new Promise((r) => setTimeout(r, 90000));
const lines = stack.serverLog().split('\n').filter((l) => /unbury|below-ground/.test(l));
console.log('SERVER-BURY-LINES', lines.length);
for (const l of lines.slice(-25)) {console.log('  SRV', l.slice(0, 400));}
await closeClient(c); stack.down();
