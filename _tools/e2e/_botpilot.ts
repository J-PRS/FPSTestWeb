/** _botpilot.ts — real browser clients driven by the shared BotBrain
 *  (?autopilot=1). Each piloted window IS a netbot: real socket, real
 *  inputs, real prediction — server bots only fill the leftover seats.
 *  Headed when E2E_HEADED=1. Samples conn/parity every 2s per client.
 *
 *    bun _tools/e2e/_botpilot.ts [secs] [pilots] [serverBots] [map]
 *    E2E_HEADED=1 bun _tools/e2e/_botpilot.ts 120 3 8 rimrock
 */
import { launchClient, closeClient, type Client } from './browser.ts';
import { upStack } from './env.ts';

const SECS = Number(process.argv[2] ?? 120);
const PILOTS = Number(process.argv[3] ?? 1);
const BOTS = process.argv[4] ?? '8';
const MAP = process.argv[5] ?? 'rimrock';
const stack = await upStack();

const glitches = new Map<string, number>();
const glitchLines: string[] = [];
const clients: Client[] = [];
for (let i = 0; i < PILOTS; i += 1) {
  // A Chrome that can't load the page in ~35s is a load-bound host, not a
  // wiring bug — retry once, then run with the pilots that did arm.
  let c: Client | null = null;
  for (let attempt = 0; attempt < 2 && !c; attempt += 1) {
    c = await launchClient(stack.clientUrl(`&room=pilotsoak&bots=${BOTS}&map=${MAP}&mode=headhunt&autopilot=1${process.env.E2E_EXTRA ?? ''}`)).catch(() => null);
  }
  if (!c) {console.log(`p${i} never loaded — continuing with ${clients.length} pilot(s)`); continue;}
  const pi = clients.length; // label = roster index, not the request slot
  c.page.on('console', async (m) => {
    const t = m.text();
    if (t.includes('[GLITCH:')) {
      const tag = /GLITCH:([a-z-]+)/.exec(t)?.[1] ?? '?';
      glitches.set(tag, (glitches.get(tag) ?? 0) + 1);
      // Capture full payload from console args
      try {
        const args = m.args();
        if (args.length > 1) {
          const val = await args[1].jsonValue();
          glitchLines.push(`[p${pi}] GLITCH:${tag} ` + JSON.stringify(val));
        } else {
          glitchLines.push(`[p${pi}] ` + t.slice(0, 220));
        }
      } catch {
        glitchLines.push(`[p${pi}] ` + t.slice(0, 220));
      }
    }
  });
  clients.push(c);
}

try {
  for (const c of clients) {
    await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
    await c.waitFor(`window.__botpilot`, 20000);
  }
  console.log(`${clients.length} pilot(s) armed — soaking ${SECS}s`);
  const t0 = Date.now();
  const moved = clients.map((): number => 0);
  const lastPos = clients.map((): { x: number; z: number } | null => null);
  const drops = clients.map((): number => 0);
  const prevConn = clients.map((): boolean => true);
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    for (let i = 0; i < clients.length; i += 1) {
      const s = await clients[i]!.test<{
        conn: boolean; ping: number; loss: number; x: number; z: number; spd: number;
        dead: boolean; hp: number; fps: number; remotes: number;
      }>(`(() => {
        const nm = t.networkManager, p = t.player;
        return { conn: nm.isConnected(), ping: Math.round(nm.getPing()),
          loss: nm.getPacketLoss(), x: p.pos.x, z: p.pos.z,
          spd: Math.round(Math.hypot(p.vel.x, p.vel.z)),
          dead: p.isDead, hp: Math.round(p.health),
          fps: Math.round(t.perf?.fps ?? 0), remotes: t.world.remotePlayers.entities.size };
      })()`).catch(() => null);
      if (!s) {continue;}
      if (!s.conn && prevConn[i]) {drops[i]! += 1; console.log(`  DROP p${i} t=${((Date.now() - t0) / 1000).toFixed(0)}s`);}
      prevConn[i] = s.conn;
      const lp = lastPos[i];
      if (lp) {moved[i]! += Math.hypot(s.x - lp.x, s.z - lp.z);}
      lastPos[i] = s;
      if (!s.conn || s.loss > 2) {console.log(`  t=${((Date.now() - t0) / 1000).toFixed(0)}s p${i} ${JSON.stringify(s)}`);}
    }
  }
  console.log(`RESULT ${clients.map((_, i) => `p${i}:drops=${drops[i]} moved=${moved[i]!.toFixed(0)}m`).join('  ')}`);
  console.log(`GLITCH counts:`);
  for (const [tag, n] of [...glitches].sort((a, b) => b[1] - a[1])) {console.log(`  ${tag}: ${n}`);}
  const dmg = glitchLines.filter((l) => l.includes('dmg-echo'));
  // Payloads arrive JSON-escaped through the arg-capture path — match the
  // escaped and plain forms so a real 'none' verdict can't hide in quotes.
  const none = dmg.filter((l) => /srvAt\\?":\\?"none"/.test(l) || l.includes('srvAt:"none"'));
  console.log(`dmg-echo: ${dmg.length} total — srvAt:none ${none.length}, srv-coords ${dmg.length - none.length}`);
  for (const l of dmg.slice(0, 25)) {console.log(`  ${l}`);}
  // Server's own drop ledger — a srvAt:none with matching drop.* counts
  // means the intent was refused (cadence/class/belt), not lost on the wire.
  const metrics = await stack.serverMetrics().catch(() => null);
  if (metrics) {console.log(`server metrics: ${JSON.stringify(metrics)}`);}
  // Parity internals — fatesSeen vs echoesStamped settles "intent never
  // ran" vs "destroy never arrived" without a packet dump.
  for (let i = 0; i < clients.length; i += 1) {
    const pr = await clients[i]!.test(`(() => t.parity ?? null)()`).catch(() => null);
    if (pr) {console.log(`[p${i}] parity: ${JSON.stringify(pr)}`);}
    // Lane-vitality canary: the server round-robins a `ping` to every
    // human ~0.5s. A seat that ran >10s connected and saw zero ping is a
    // zombie — blind to events even if inputSync trickles (which is the
    // starvation signal, not life). This assert turns "the wire looked
    // quiet" from a log curiosity into a soak failure.
    const pingSeen = (pr as { msgSeen?: Record<string, number> } | null)?.msgSeen?.ping ?? 0;
    if (pingSeen === 0 && (pr as { msgSeen?: Record<string, number> } | null)?.msgSeen?.gameState) {
      console.log(`[p${i}] FAIL — zombie seat: connected >10s, zero ping/keepalive ever arrived`);
      process.exitCode = 1;
    }
  }
} finally {
  for (const c of clients) {await closeClient(c).catch((): void => { return; });}
  stack.down();
}
