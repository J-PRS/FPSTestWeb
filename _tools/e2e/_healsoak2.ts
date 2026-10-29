// Live heal-beam soak — real server + ctf room of spec bots, un-hibernated
// by wideSoak netbot seats (real sockets = human audience). Polls the room's
// cumulative health counters for heal.beam usage.
//   bun _tools/e2e/_healsoak2.ts [wallSecs]
import { upStack } from './env.ts';

const secs = Number(process.argv[2] ?? 180);
const stack = await upStack();
let soak: ReturnType<typeof Bun.spawn> | null = null;
try {
  const join = await fetch(`http://localhost:${stack.serverPort}/join?mode=ctf&bots=16`).then(r => r.json());
  console.log('room:', JSON.stringify(join));
  // Two netbot humans into the same room — hibernation lifts, bots fight.
  soak = Bun.spawn([process.execPath, '../tools/netbot/wideSoak.ts',
    '--rooms', '1', '--bots', '2', '--seconds', String(secs + 60),
    '--pace', '50', '--join-parallel', '2',
    '--url', `ws://localhost:${stack.serverPort}/ws`, '--roombase', 'ctf'],
    { cwd: 'server_bun', stdout: 'ignore', stderr: 'ignore' });
  for (let t = 0; t < secs; t += 30) {
    await new Promise(r => setTimeout(r, 30000));
    const m = await stack.serverMetrics() as { rooms?: { name: string; players?: unknown; health: Record<string, number> }[] };
    const room = m.rooms?.find(r => r.name === join.room);
    const h = room?.health ?? {};
    const healish = Object.entries(h).filter(([k]) => /heal|hit|kill|shot|nade/i.test(k));
    console.log(`t+${t + 30}s  ${healish.length ? healish.map(([k, v]) => `${k}=${v}`).join(' ') : 'no combat counters'}`);
  }
  const m = await stack.serverMetrics() as { rooms?: { name: string; health: Record<string, number> }[] };
  const room = m.rooms?.find(r => r.name === join.room);
  console.log('\nALL counters:', JSON.stringify(room?.health ?? {}));
} finally { try { soak?.kill(); } catch {} await stack.down(); }
