/**
 * _jetprobe.ts — offline headhunt: install an in-page accumulator that
 * tracks per-bot HA time (>5m AGL), posted-role time, and recon fires.
 * Answers "who doesn't climb and why" in one ~24s run.
 *   E2E_GPU=1 bun _tools/e2e/_jetprobe.ts [--secs 24]
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack, type Stack } from './env.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const SECS = Number(arg('secs', '24'));

const stack: Stack = await upStack();
const url = `http://localhost:${stack.clientPort}/?debug&solo&map=rimrock&bots=15&mode=headhunt`;
const client = await launchClient(url);

try {
  await client.waitFor(`t.teamBots && t.teamBots.bots.length > 0`, 45000);
  await client.test(`(() => {
    window.__haProbe = { t0: performance.now(), bots: {} };
    window.__haProbeTimer = setInterval(() => {
      const t = window.__test; if (!t?.teamBots || !t.terrain) {return;}
      for (const b of t.teamBots.bots) {
        const r = window.__haProbe.bots[b.playerId] ??= { ha: 0, n: 0, posted: 0, recon: 0, en: 0, why: {} };
        const feetY = b.position.y - 1.7;
        const g = Math.max(t.terrain.getHeight(b.position.x, b.position.z), t.terrain.getRenderedHeight(b.position.x, b.position.z));
        r.n += 1; if (feetY - g > 5) {r.ha += 1;}
        const br = b.brain;
        if (br?.lastPosted) {r.posted += 1;}
        const why = br?.jetDebug?.why ?? '-';
        r.why[why] = (r.why[why] ?? 0) + 1;
        if (why === 'recon') {r.recon += 1;}
        r.en += b.energy ?? 0;
      }
    }, 250);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  const rows = await client.test<{ id: string; ha: number; n: number; posted: number; recon: number; en: number; why: Record<string, number> }[]>(`(() => {
    clearInterval(window.__haProbeTimer);
    return JSON.stringify(Object.entries(window.__haProbe.bots).map(([id, r]) => ({ id, ...r })));
  })()`);
  const list = JSON.parse(rows as unknown as string) as { id: string; ha: number; n: number; posted: number; recon: number; en: number; why: Record<string, number> }[];
  console.log(`--- ${SECS}s offline headhunt rimrock ---`);
  console.log('id                 HA%  posted%  recon%  enAvg  topWhy');
  for (const r of list.sort((a, b) => b.ha / b.n - a.ha / b.n)) {
    const top = Object.entries(r.why).sort((a, b) => b[1] - a[1])[0];
    console.log(`${r.id.padEnd(18)} ${(100 * r.ha / r.n).toFixed(1).padStart(5)} ${(100 * r.posted / r.n).toFixed(7).padStart(8)} ${(100 * r.recon / r.n).toFixed(7).padStart(8)} ${(r.en / r.n).toFixed(0).padStart(6)}  ${top?.[0] ?? '-'}=${top?.[1]}`);
  }
} finally {
  await closeClient(client);
  stack.down();
}
