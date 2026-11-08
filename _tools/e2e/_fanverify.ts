/* oxlint-disable no-console */
// Fan-parity soak: seed a medium kit that is ALL pellet fans (flak wid 5,
// shotgun wid 9) so every predicted pull exercises the Vogel-spiral
// prediction fix. Reports the parity census + any wt:6/9 echoes.
import { launchClient, closeClient } from './browser.ts';
const SECS = Number(process.argv[2] ?? '240');
const ROOM = process.argv[3] ?? 'headhunt-1';
const URL = `http://127.0.0.1:5400/?server=https://play.jprice.app&room=${ROOM}&net=ws&autopilot`;
const PRELOAD = `localStorage.setItem('fps-class','medium');
localStorage.setItem('fps-loadout','5,9,5,9');
localStorage.setItem('fps-loadout-medium','5,9,5,9');
localStorage.setItem('fps-loadout-light','5,9,5,9');
localStorage.setItem('fps-loadout-heavy','5,9,5,9');`;
const a = await launchClient(URL, { preload: PRELOAD });
const parity = (): Promise<string> => a.test<string>(`JSON.stringify(window.__test.parity)`);
try {
  await a.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  console.log('connected - kit pinned to fans');
  const kit = await a.test<string>(`JSON.stringify(window.__test.player?.loadout)`);
  console.log('live loadout:', kit);
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) { await new Promise(r => setTimeout(r, 20000)); }
  console.log('parity:', await parity());
} finally { await closeClient(a); }
