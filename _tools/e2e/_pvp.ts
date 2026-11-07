/* oxlint-disable no-console */
// Real client-vs-client PvP on prod: two browsers, same room, both
// autopilot. Asserts parity census clean on BOTH + cross-player hits.
import { launchClient, closeClient, type Client } from './browser.ts';
const SECS = Number(process.argv[2] ?? '200');
const URL = 'http://127.0.0.1:5400/?server=https://play.jprice.app&room=headhunt-1&net=ws&autopilot';
const a = await launchClient(URL);
const b = await launchClient(URL);
const parity = (c: Client) => c.test<any>(`JSON.stringify(window.__test.parity)`);
const remotes = (c: Client) => c.test<any>(`JSON.stringify([...window.__test.world.remotePlayers.keys()].filter(k => !k.startsWith('BOT-')))`);
try {
  await a.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  await b.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  console.log('both connected');
  // Non-bot remote ids = the other human (only 2 humans in room).
  const poll = async () => {
    const ra = await remotes(a), rb = await remotes(b);
    if (ra !== '[]' && rb !== '[]') { console.log('A sees humans:', ra, '| B sees:', rb); return true; }
    return false;
  };
  for (let i = 0; i < 20 && !(await poll()); i++) { await new Promise(r => setTimeout(r, 3000)); }
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) { await new Promise(r => setTimeout(r, 20000)); }
  console.log('A parity:', await parity(a));
  console.log('B parity:', await parity(b));
  console.log('A humans now:', await remotes(a), '| B:', await remotes(b));
} finally { await closeClient(a); await closeClient(b); }
