/**
 * dualcheck.ts — the desync oracle, automated. One stage does the whole
 * loop the manual pieces used to need:
 *
 *   1. upStack spawns a dedicated server (FPS_DEMO recording) + vite
 *   2. seat a headless client into a bot-filled room, let real combat run
 *   3. pull the client's .demo (its lossy lens) + flush the server's
 *      authoritative demo mid-match via /admin/demodump
 *   4. demodiff the pair — posΔ truth AND paired damage/spawn event truth
 *
 *   bun _tools/e2e/dualcheck.ts [--secs=45] [--room=dualrun]
 *
 * Exit 0 = wire-clean. Any gated missed event or kill-lane fabrication
 * fails nonzero — that is the "no missing damage" oracle.
 */
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const opt = (name: string, dflt: string): string => {
  const a = process.argv.find((x): boolean => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const ROOM = opt('room', `dualrun_${Date.now().toString(36)}`);
const SECS = Number(opt('secs', '45'));
const BUN = process.execPath;
// Absolute paths — all.ts runs specs with cwd=_tools/e2e.
const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLI_DEMO = `${REPO}demos_out/dual_${ROOM}.demo`;

// upStack propagates env to the spawned server — FPS_DEMO arms the
// room's authoritative recorder; the token matches env.ts's default.
process.env.FPS_DEMO = resolve(REPO, 'demos_out/server'); // spawned server's cwd is server_bun — absolute or the flush lands there
mkdirSync(process.env.FPS_DEMO, { recursive: true });
const stack = await upStack();
console.log(`server :${stack.serverPort} client :${stack.clientPort} room=${ROOM} recording ${SECS}s`);

try {
  // A fresh joiner into a real combat room — bots already fighting.
  const c = await launchClient(stack.clientUrl(`&room=${ROOM}&mode=ctf&bots=8`));
  await c.waitFor(`window.__test && window.__test.demoManager && window.__test.networkManager && window.__test.networkManager.isConnected()`, 60000);
  console.log('seated — recording');
  await new Promise((r): void => { setTimeout(r, SECS * 1000); });

  // Client lens — what this observer's wire actually delivered.
  const b64 = await c.page.evaluate(`(async () => {
    const dm = window.__test.demoManager;
    const f = dm.recorder.buildDemoFile('dualcheck client lens');
    const { serializeDemo } = await import('/src/demo/demoWriter.js');
    const buf = new Uint8Array(serializeDemo(f));
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
    return btoa(s);
  })()`);
  writeFileSync(CLI_DEMO, Buffer.from(b64, 'base64'));
  console.log('WROTE', CLI_DEMO);
  await closeClient(c);
} finally {
  // Server truth — mid-match flush while the room is still alive.
  const token = process.env.FPS_ADMIN_TOKEN ?? 'testadmin';
  try {
    const dump = await (await fetch(`http://localhost:${stack.serverPort}/admin/demodump?room=${ROOM}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })).json() as { ok: boolean; file?: string; result?: string };
    if (dump.ok && dump.file) {
      console.log('server demo:', dump.file);
      await stack.down();
      const r = spawnSync(BUN, [`${REPO}_tools/demodiff.ts`, CLI_DEMO, dump.file], { stdio: 'inherit', cwd: REPO });
      process.exit(r.status ?? 1);
    }
    console.error(`demodump failed: ${JSON.stringify(dump)}\n--- server log ---\n${stack.serverLog().slice(-4000)}`);
  } catch (e) { console.error(`demodump threw: ${e}`); }
}
await stack.down();
process.exit(2);
