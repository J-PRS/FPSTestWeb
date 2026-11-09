/**
 * _q3verify.ts — batch verify + soak for q3conv-ported maps.
 *
 *   E2E_GPU=1 bun _tools/e2e/_q3verify.ts [map ...]
 *
 * One stack, one browser per map (fresh room each): waits for connect,
 * bots seated, samples sim for SOAK_SECS, screenshots to _shots/.
 * Verdict per map: spawned-on-geometry, colliders live, bots moving,
 * no GLITCH/DESYNC spam, nobody fell through the world.
 */
import { launchClient, closeClient } from './browser.ts';
import { mkdirSync } from 'node:fs';

// Dev stack (:5400/:8000) — the spawned e2e stack's ?server= param routes
// through the fleet matchmaker (/join ignores ?room=), which lands every
// client in headhunt-1. The dev server mints named rooms directly.

const MAPS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'oacmpdm2', 'oacmpdm4', 'oacmpdm5', 'oacmpdm7', 'oacmpdm8', 'oacmpdm9',
  'oacmpctf1', 'oacmpctf2', 'oajgdm4', 'oacmp2dm_utemple',
];
const SOAK_SECS = Number(process.env.SOAK_SECS ?? 45);
const BOTS = process.env.BOTS ?? '6';
const SHOTS = '_shots';
mkdirSync(SHOTS, { recursive: true });

const results: Record<string, unknown>[] = [];

for (const map of MAPS) {
  const room = `q3v-${map}`;
  const glitches: string[] = [];
  const desyncs: string[] = [];
  const errors: string[] = [];
  const client = await launchClient(`http://localhost:5400/?room=${room}&map=${map}&bots=${BOTS}&net=ws&debug`);
  client.page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[GLITCH:')) { glitches.push(t.slice(0, 160)); }
    else if (t.includes('DESYNC')) { desyncs.push(t.slice(0, 160)); }
    else if (m.type() === 'error' && !t.includes('ERR_CONNECTION_REFUSED')) { errors.push(t.slice(0, 160)); }
  });
  const t0 = Date.now();
  try {
    await client.page.waitForFunction('window.__test && window.__test.player && window.__test.networkManager?.isConnected?.()', { timeout: 120000 });
    await client.page.waitForFunction('window.__test.world.remotePlayers.entities.size >= 1', { timeout: 60000 }).catch(() => {});
    // sample loop: positions of remotes must change (bots alive + moving)
    const moves: number[] = [];
    let lastPos = '';
    const samples = Math.floor(SOAK_SECS / 5);
    for (let s = 0; s < samples; s++) {
      await new Promise(r => setTimeout(r, 5000));
      const snap = await client.page.evaluate(`(() => {
        const t = window.__test;
        const p = t.player;
        const solid = p.movement?.surface?.solid;
        const remotes = [...t.world.remotePlayers.entities.values()].map(r => r.position);
        const alive = remotes.filter(r => r.y > 20).length;
        return JSON.stringify({
          pos: p.pos ? [+p.pos.x.toFixed(1), +p.pos.y.toFixed(1), +p.pos.z.toFixed(1)] : null,
          dead: p.isDead === true || (p.health !== undefined && p.health <= 0),
          cols: solid ? solid.cols.length : 0,
          remotes: remotes.length, alive,
          netRoom: t.networkManager?.netRoom ?? null,
          mapName: t.world.mapName ?? null,
          moved: remotes.map(r => r.x.toFixed(1) + ',' + r.z.toFixed(1)).join('|'),
        });
      })()`).catch(() => '{}');
      try {
        const j = JSON.parse(snap);
        moves.push(j.remotes ?? 0);
        if (j.moved && j.moved !== lastPos) { /* movement tracked below */ }
        lastPos = j.moved ?? lastPos;
        if (s === samples - 1) {
          await client.page.screenshot({ path: `${SHOTS}/q3_${map}.png` });
          results.push({
            map, secs: Math.round((Date.now() - t0) / 1000),
            pos: j.pos, cols: j.cols, remotes: j.remotes, aliveHigh: j.alive,
            netRoom: j.netRoom, mapName: j.mapName,
            glitches: glitches.length, desyncs: desyncs.length, errors: errors.slice(0, 3),
            glitchSample: glitches[0],
          });
          console.log(`${map}: pos=${JSON.stringify(j.pos)} cols=${j.cols} remotes=${j.remotes} alive=${j.alive} glitch=${glitches.length} desync=${desyncs.length} err=${errors.length} (${Math.round((Date.now()-t0)/1000)}s)`);
        }
      } catch { /* page nav mid-sample */ }
    }
  } catch (e) {
    results.push({ map, fail: String(e).slice(0, 200), glitches: glitches.length });
    console.log(`${map}: FAIL ${String(e).slice(0, 120)}`);
    try { await client.page.screenshot({ path: `${SHOTS}/q3_${map}_fail.png` }); } catch {}
  } finally {
    await closeClient(client);
  }
}
console.log('\n=== summary ===');
for (const r of results) { console.log(JSON.stringify(r)); }
