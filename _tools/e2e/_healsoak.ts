// Live-server heal-beam soak — real game server on a probed port,
// a ctf room of bots fighting ~90 wall-seconds, then /metrics reads
// the room health counters: did medics actually fire the beam?
//   bun _tools/e2e/_healsoak.ts [bots] [wallSecs]
import { upStack } from './env.ts';

const bots = process.argv[2] ?? '16';
const secs = Number(process.argv[3] ?? 90);

const stack = await upStack();
try {
  const join = await fetch(`http://localhost:${stack.serverPort}/join?mode=ctf&bots=${bots}`).then(r => r.json());
  console.log('room:', JSON.stringify(join));
  for (let t = 0; t < secs; t += 15) {
    await new Promise(r => setTimeout(r, 15000));
    const m = await stack.serverMetrics() as Record<string, unknown>;
    const totals = JSON.stringify(m).match(/"heal[^"]*":\d+|"drop\.tankDry":\d+|"drop\.healPace":\d+/g) ?? [];
    console.log(`  t+${t + 15}s  ${totals.join('  ') || 'no heal counters yet'}`);
  }
  const m = await stack.serverMetrics() as Record<string, unknown>;
  const s = JSON.stringify(m);
  const heal = s.match(/"heal\.beam":(\d+)/);
  console.log('\nFINAL health counters:');
  for (const [k, v] of Object.entries(m)) {
    const str = JSON.stringify(v);
    for (const mm of str.matchAll(/"([a-z.]+)":(\d+)/g)) {
      if (/heal|tankDry|hit|kill|shot/i.test(mm[1]!)) {console.log(`  ${mm[1]}: ${mm[2]}`);}
    }
  }
  console.log('heal.beam ticks:', heal?.[1] ?? '0');
} finally { await stack.down(); }
