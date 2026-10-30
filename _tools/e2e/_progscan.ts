// Which program is invalid? List renderer programs + diagnostics,
// plus a targeted console capture of the useProgram warnings.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 9000));
  const out = await client.page.evaluate(`(() => {
    const r = window.__renderer;
    if (!r) { return 'no __renderer'; }
    const progs = (r.info.programs || []).map((p) => ({
      name: p.name, usedTimes: p.usedTimes,
      diag: p.diagnostics ? JSON.stringify(p.diagnostics).slice(0, 300) : null,
    }));
    const bad = progs.filter((p) => p.diag);
    return JSON.stringify({ total: progs.length, bad, sample: progs.slice(0, 5) }, null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
