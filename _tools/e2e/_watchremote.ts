/* oxlint-disable no-console */
// Visible client on the REMOTE server — observe live bot behavior while
// the netbot soak runs. E2E_HEADED=1 gives a real window; Ctrl+C closes.
import { launchClient } from './browser.ts';

const room = process.env.WATCH_ROOM ?? 'headhunt-1';
const c = await launchClient(
  `http://localhost:5400/?server=wss://play.jprice.app/ws&room=${room}`,
);
await c.waitFor(`window.__test && window.__test.player`, 60000);
console.log(`watching ${room} on play.jprice.app — close the window or Ctrl+C to stop`);
// Keep the process alive; the window stays until killed.
await new Promise((): void => {});
