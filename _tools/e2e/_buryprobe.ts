// Buried-remote probe: sample remotes, at each 'buried' reading record
// logical vs rendered height + pos so the delta names WHICH surface diverges.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const secs = Number(process.argv[2] ?? 60);
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&mode=ctf&bots=16'));
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await client.test(`(() => {
    const j = window.__bury = { rows: [] };
    j.timer = setInterval(() => {
      for (const [id, rp] of (t.world?.remotePlayers ?? [])) {
        const p = rp.position;
        const t0 = rp.terrain;
        if (!p || !t0) {continue;}
        const eye = rp.eyeOff ?? 0;
        const feetY = p.y - eye;
        const rH = t0.getRenderedHeight(p.x, p.z);
        const lH = t0.getHeight(p.x, p.z);
        const bury = rH - feetY;
        if (bury > 1 && j.rows.length < 300) {
          j.rows.push({ id: String(id).slice(-8), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1),
            bury: +bury.toFixed(1), rH: +rH.toFixed(1), lH: +lH.toFixed(1), dRender: +(rH - lH).toFixed(1),
            dead: rp.isDead ? 1 : 0 });
        }
      }
    }, 50);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  const rows = await client.test<Record<string, unknown>[]>(`(() => { clearInterval(window.__bury.timer); return window.__bury.rows; })()`);
  // Aggregate per remote: worst burial + how much is rendered>logical.
  const byId = new Map<string, { n: number; max: number; sumDrift: number; worstDrift: number; dead: number }>();
  for (const r of rows ?? []) {
    const id = String(r.id);
    const a = byId.get(id) ?? { n: 0, max: 0, sumDrift: 0, worstDrift: 0, dead: 0 };
    a.n += 1;
    a.max = Math.max(a.max, Number(r.bury));
    a.sumDrift += Number(r.dRender);
    a.worstDrift = Math.max(a.worstDrift, Number(r.dRender));
    a.dead = Math.max(a.dead, Number(r.dead));
    byId.set(id, a);
  }
  for (const [id, a] of byId) {
    console.log(`${id}: n=${a.n} buryMax=${a.max}m avgRenderDrift=${(a.sumDrift / a.n).toFixed(1)}m worstDrift=${a.worstDrift}m dead=${a.dead}`);
  }
  const worst = [...(rows ?? [])].sort((a, b) => Number(b.bury) - Number(a.bury)).slice(0, 15);
  console.log('worst rows:', JSON.stringify(worst));
} finally { await closeClient(client); stack.down(); }
