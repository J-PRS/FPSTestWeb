/* oxlint-disable no-console */
// Server-bot locomotion truth, no browser: a headless netbot joins a live
// room asking for 15 server bots. Two drift measurements 8s apart —
// roster (wire truth the client sees) vs /metrics botParked (sim truth
// the server runs). Sim moves + wire still = wire/remoteVis bug;
// sim parked = ServerBots/brain bug in live rooms.
import { upStack } from './env.ts';
import { NetClient } from '../../tools/netbot/netClient.ts';

const stack = await upStack();
const ROOM = process.argv[2] ?? 'bpos';
const nc = new NetClient(`ws://127.0.0.1:${stack.serverPort}/ws`, `bpos${Date.now().toString(36)}`, undefined,
  ROOM === 'bpos' ? { room: 'bpos', mode: 'headhunt', map: 'rimrock', bots: 15 } : { room: ROOM, mode: 'headhunt' });
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
try {
  await nc.connect();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if ([...nc.roster.keys()].filter(id => id.startsWith('BOT-')).length >= 10) {break;}
    await sleep(500);
  }
  await sleep(6000); // settle + first moves
  const snap = (): Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }> => {
    const m = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>();
    for (const [id, e] of nc.roster) {
      if (id.startsWith('BOT-')) {m.set(id, { x: e.pos.x, y: e.pos.y, z: e.pos.z, vx: e.vel?.x ?? 0, vy: e.vel?.y ?? 0, vz: e.vel?.z ?? 0 });}
    }
    return m;
  };
  const a = snap();
  await sleep(8000);
  const b = snap();
  console.log('id                 wireDrift8s  wireSpeed');
  for (const [id, p] of b) {
    const q = a.get(id);
    if (!q) {continue;}
    const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const sp = Math.hypot(p.vx, p.vy, p.vz);
    console.log(`${id.padEnd(20)} ${d.toFixed(1).padStart(9)} ${sp.toFixed(1).padStart(9)}`);
  }
  const key = process.env.FPS_ADMIN_TOKEN ?? 'testadmin';
  const m1 = await fetch(`http://127.0.0.1:${stack.serverPort}/metrics?key=${key}`).then(r => r.json()).catch(() => null) as any;
  await sleep(4000);
  const m2 = await fetch(`http://127.0.0.1:${stack.serverPort}/metrics?key=${key}`).then(r => r.json()).catch(() => null) as any;
  const xz = (mm: any): Map<string, string> => {
    const out = new Map<string, string>();
    for (const room of mm?.rooms ?? []) {
      for (const r of room.botParked ?? []) {
        const m = /xz=([-\d.]+),([-\d.]+)/.exec(r.mv ?? '');
        if (m) {out.set(`${room.name}/${r.id}`, `${m[1]},${m[2]}`);}
      }
    }
    return out;
  };
  const s1 = xz(m1), s2 = xz(m2);
  for (const room of m2?.rooms ?? []) {
    console.log(`room ${room.name}: botIdle=${JSON.stringify(room.botIdle)}`);
    for (const r of (room.botParked ?? []).slice(0, 16)) {
      const m = /xz=([-\d.]+),([-\d.]+)/.exec(r.mv ?? '');
      const prev = m ? s1.get(`${room.name}/${r.id}`) : undefined;
      const d = m && prev ? Math.hypot(parseFloat(m[1]!) - parseFloat(prev.split(',')[0]!), parseFloat(m[2]!) - parseFloat(prev.split(',')[1]!)) : -1;
      console.log(`  ${r.id} sp=${r.sp} simDrift4s=${d.toFixed(1)} dest=${r.dest} goal=${r.goal} mv=${r.mv}`);
    }
  }
} finally {
  nc.close();
  stack.down();
}
