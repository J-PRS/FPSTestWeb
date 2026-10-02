/**
 * mapshot.ts — join a named map room, teleport to a vantage point, shoot.
 *   bun _tools/e2e/mapshot.ts <map> [x z] [yaw pitch]
 * Defaults frame escalade's alpha base. Writes _tools/e2e/shots/map_<n>.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'escalade';
const [vx, vz] = (process.argv[3] ?? '126 40').split(' ').map(Number);
const [yaw, pitch] = (process.argv[4] ?? '0 -0.15').split(' ').map(Number);
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const url = stack.clientUrl(`&room=${map}&bots=0&net=ws`);
console.log('stack server', stack.serverPort, 'client', stack.clientPort, url);

// Direct wire probe — what does the spawned server actually echo?
let probeWs: WebSocket | null = null;
await new Promise<void>((res) => {
  const ws = new WebSocket(`ws://localhost:${stack.serverPort}/ws`);
  probeWs = ws;
  const t = setTimeout(() => { console.log('probe: timeout'); res(); }, 5000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: 'mapshotprobe', room: map, bots: 0 }));
  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(String(e.data));
      if (d.type === 'gameState') {
        console.log('probe map keys:', Object.keys(d.map ?? {}), 'interiors:', d.map?.interiors?.length);
        clearTimeout(t); res(); // stays CONNECTED — holds the room alive
      }
    } catch { /* binary tick frames */ }
  };
  ws.onerror = () => { console.log('probe: ws error'); clearTimeout(t); res(); };
});

const client = await launchClient(url);
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  // Wait a beat for the terrain swap + interiors to land.
  await new Promise(r => setTimeout(r, 4000));
  await client.page.evaluate(`(() => {
    const p = window.__test.player;
    const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${vx}, ${vz}) : 60;
    p.pos.set(${vx}, h + 55, ${vz});
    p.vel.set(0, 0, 0);
    p.yaw = ${yaw}; p.pitch = ${pitch};
    p.syncMovement && p.syncMovement();
    p.markTeleport && p.markTeleport();
  })()`);
  await new Promise(r => setTimeout(r, 3000));
  const diag = await client.page.evaluate(`(() => {
    const s = window.__test.scene;
    const g = s && s.getObjectByName('__t2interiors');
    const nm = window.__test.networkManager;
    const T = window.__test.THREE;
    const boxes = [];
    if (g && T) {
      for (const c of g.children) {
        const b = new T.Box3().setFromObject(c);
        const sz = b.getSize(new T.Vector3());
        boxes.push({ type: c.type, n: c.name || '',
          size: [sz.x | 0, sz.y | 0, sz.z | 0],
          min: [b.min.x | 0, b.min.y | 0, b.min.z | 0] });
      }
    }
    return {
      groupExists: !!g,
      interiors: g ? g.children.length : 0,
      connected: nm && nm.connected,
      boxes: boxes.slice(0, 40),
      mapFetches: performance.getEntriesByType('resource')
        .map(e => e.name).filter(n => n.includes('/maps/')).slice(0, 12),
    };
  })()`);
  console.log('diag', JSON.stringify(diag, null, 1).slice(0, 4000));
  // Probe the SAME room again — did the spec mutate after browser join?
  await new Promise<void>((res) => {
    const ws = new WebSocket(`ws://localhost:${stack.serverPort}/ws`);
    const t = setTimeout(() => res(), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: 'probe2', room: map, bots: 0 }));
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(String(e.data));
        if (d.type === 'gameState') {
          console.log('probe2 map keys:', Object.keys(d.map ?? {}), 'interiors:', d.map?.interiors?.length);
          clearTimeout(t); ws.close(); res();
        }
      } catch { /* binary */ }
    };
    ws.onerror = () => { clearTimeout(t); res(); };
  });
  console.log('--- server log tail ---\n' + stack.serverLog().slice(-3000));
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `map_${map}.png`);
  await client.page.screenshot({ path: file });
  console.log('wrote', file);
  // Bisect: interiors hidden, then sky background removed.
  await client.page.evaluate(`(() => {
    const g = window.__test.scene.getObjectByName('__t2interiors');
    if (g) g.visible = false;
  })()`);
  await new Promise(r => setTimeout(r, 500));
  await client.page.screenshot({ path: join(OUT, `map_${map}_noint.png`) });
  await client.page.evaluate(`(() => {
    const s = window.__test.scene;
    const g = s.getObjectByName('__t2interiors');
    if (g) g.visible = true;
    window.__savedBg = s.background;
    s.background = null;
  })()`);
  await new Promise(r => setTimeout(r, 500));
  await client.page.screenshot({ path: join(OUT, `map_${map}_nosky.png`) });
  console.log('wrote bisect shots');
  await client.page.evaluate(`(() => {
    window.__test.scene.background = window.__savedBg ?? window.__test.scene.background;
  })()`);
  // Yaw sweep — locate which cube face carries the wedge.
  for (let i = 0; i < 4; i++) {
    await client.page.evaluate(`(() => {
      const p = window.__test.player;
      const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${vx}, ${vz}) : 60;
      p.pos.set(${vx}, h + 80, ${vz});
      p.yaw = ${i} * Math.PI / 2; p.pitch = 0.3;
    })()`);
    await new Promise(r => setTimeout(r, 800));
    await client.page.screenshot({ path: join(OUT, `map_${map}_yaw${i}.png`) });
  }
  console.log('wrote yaw sweep');
} finally {
  probeWs?.close();
  await closeClient(client);
  stack.down();
}
