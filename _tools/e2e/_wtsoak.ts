/** _wtsoak.ts — WT mid-life teardown repro (netcode gap item 9).
 *
 *   E2E_HEADED=1 bun _tools/e2e/_wtsoak.ts [secs]
 *
 * One client on the WebTransport tier in a bot room, left running past
 * the ~72-105s window where headless soaks saw `session.closed` resolve
 * with an empty reason. Polls tier/lane-health counters and captures
 * console lines so a teardown + recover is visible with timestamps.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { LatencyLink } from '../../tools/netbot/latency.ts';
import { NetClient } from '../../tools/netbot/netClient.ts';
import { NetBot } from '../../tools/netbot/bot.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../shared/botLoadouts.ts';

const SECS = Number(process.argv[2] ?? '180');
const NBOTS = Number(process.argv[3] ?? '6');
const ROOM = 'wtsoak';
// STACK_SERVER_PORT reuses a live server (e.g. one already tunneled by
// cloudflared) so WAN netbots and the headed client land in one room.
const stack = await upStack({ serverPort: process.env.STACK_SERVER_PORT ? Number(process.env.STACK_SERVER_PORT) : undefined });
const c = await launchClient(stack.clientUrl(`&room=${ROOM}&mode=ffa&net=wt`));

// Real wire players in the same room — WAN-simulated WS netbots, so the
// headed client's tick stream/claims contend like a public match.
// BOT_URL env rides the bots through a real WAN (e.g. a trycloudflare
// wss://) instead of loopback — real jitter beats LatencyLink for the
// room's contention; the headed client still probes wt on loopback.
const BOT_URL = process.env.BOT_URL ?? `ws://127.0.0.1:${stack.serverPort}/ws`;
const WAN = BOT_URL.startsWith('wss://');
const SKIERS = Number(process.env.BOT_SKIERS ?? '1');
const tag = Date.now().toString(36);
const netbots: { nc: NetClient; bot: NetBot }[] = [];
for (let i = 0; i < NBOTS; i++) {
  const lo = BOT_LOADOUTS[i % BOT_LOADOUTS.length]!;
  const nc = new NetClient(BOT_URL, `wtmix${tag}_${i}`,
    new LatencyLink({ pingMs: WAN ? 0 : 40 + i * 15, jitterMs: WAN ? 0 : 30, lossRate: WAN ? 0 : 0.005 }),
    { room: ROOM, mode: 'ffa', armorClass: botClassForLoadout(lo) });
  // BOT_SKIERS=N (default 1): the first N bots run straight-line ski
  // legs — the smooth-motion probe. Straight-line movement is the case
  // interpolation must nail; if ITS rendered path jerks, that's artifact.
  netbots.push({ nc, bot: new NetBot(nc, { loadout: lo, skier: i < SKIERS }) });
}
for (const b of netbots) { await b.nc.connect(); await new Promise((r) => setTimeout(r, 80)); }
for (const b of netbots) b.bot.start();
console.log(`${netbots.length} netbots joined room=${ROOM}`);
const consoleLines: string[] = [];
c.page.on('console', (m) => {
  const t = m.text();
  if (/session|teardown|died|reconnect|degrad|lane|disconnect|closed|reject|GLITCH|parity|ghost/i.test(t)) {
    consoleLines.push(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${t.slice(0, 220)}`);
  }
});

const t0 = Date.now();
try {
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  // Rendered-path jerk probe: every 50ms record each remote's rendered
  // position; a step >2.5× that remote's median step counts as a visible
  // pop. Chop = pops/second, not missing snapshots.
  await c.test(`(() => {
    const j = window.__jerk = { prev: new Map(), prevWire: new Map(), steps: new Map() };
    j.timer = setInterval(() => {
      const now = Date.now();
      j.frames = (j.frames ?? 0) + 1;
      j.framesMs = j.framesMs ?? [];
      if (j.lastF) {j.framesMs.push(now - j.lastF);} j.lastF = now;
      for (const [id, rp] of (t.world?.remotePlayers ?? [])) {
        const p = rp.position;
        if (!p) {continue;}
        // Model-vs-entity divergence: anim clips can displace the mesh —
        // that's visual chop netcode can't see, so track it too.
        const mp = rp.model?.model?.position ?? rp.model?.position;
        if (mp) {
          const md = Math.hypot(mp.x - p.x, mp.y - p.y, mp.z - p.z);
          let s = j.steps.get(id);
          if (s) { s.modelMax = Math.max(s.modelMax ?? 0, md); }
        }
        let s0 = j.steps.get(id);
        if (!s0) {s0 = { d: [], jerk: [], popCtx: [] }; j.steps.set(id, s0);}
        // Buried counter: rendered feet under the DRAWN terrain — the
        // "under terrain rubberbanding" complaint, counted per sample.
        const pr = j.prev.get(id);
        const wp = rp.wirePosition;
        const pw = j.prevWire.get(id);
        if (rp.terrain) {
          const g = rp.terrain.getRenderedHeight(p.x, p.z);
          const bury = g - (p.y - (rp.eyeOff ?? 0));
          if (bury > 1) {
            s0.buried = (s0.buried ?? 0) + 1;
            s0.buryMax = Math.max(s0.buryMax ?? 0, +bury.toFixed(1));
            // Split: wire ALSO under the drawn surface (genuine burial /
            // under-field dip) vs wire above while render is under
            // (interp chord shortcut — a fixable renderer artifact).
            if (wp) {
              const wb = rp.terrain.getRenderedHeight(wp.x, wp.z) - (wp.y - (rp.eyeOff ?? 0));
              if (wb > 0.5) {s0.buriedWire = (s0.buriedWire ?? 0) + 1;}
              else {s0.buriedChord = (s0.buriedChord ?? 0) + 1;}
            }
          }
        }
        let wireStep = -1;
        if (pw && wp) {
          wireStep = Math.hypot(wp.x - pw.x, wp.y - pw.y, wp.z - pw.z);
        }
        if (pr) {
          const d = Math.hypot(p.x - pr.x, p.y - pr.y, p.z - pr.z);
          const dt = now - pr.t;
          if (dt > 20 && dt < 500) {
            let s = j.steps.get(id);
            if (!s) {s = { d: [], jerk: [], popCtx: [] }; j.steps.set(id, s);}
            s.d.push(d);
            // True jerk = step the entity's own velocity can't explain.
            // Jet bursts legitimately reach 40m/s+; a pop is measured
            // distance minus what server velocity predicts over dt.
            // During dead reckoning the sim velocity is truth — the last
            // wire velocity is stale and would undercount real speed.
            const v = rp.isSimulating ? rp.velocity : (rp.serverVelocity ?? rp.velocity);
            const sv = rp.interpSimVel;
            const exp = v ? Math.hypot(v.x, v.y, v.z) * (dt / 1000) : 0;
            const jerk = d - exp;
            if (jerk > 1.2) { s.jerk.push(jerk); }
            if (jerk > 1.2 && s.popCtx.length < 8) {
              s.popCtx.push({ d: +d.toFixed(2), exp: +exp.toFixed(2), dt,
                dy: +(p.y - pr.y).toFixed(2), wire: +wireStep.toFixed(2),
                werr: wp ? +Math.hypot(p.x - wp.x, p.y - wp.y, p.z - wp.z).toFixed(2) : -1,
                svl: sv ? +Math.hypot(sv.x, sv.y, sv.z).toFixed(1) : -1,
                sim: !!rp.isSimulating, cvg: !!rp.interpConverging,
                cap: !!rp.interpAtCap,
                und: rp.interpUnderruns, delay: Math.round(rp.renderDelayMs) });
            }
          }
        }
        j.prev.set(id, { x: p.x, y: p.y, z: p.z, t: now });
        if (wp) {j.prevWire.set(id, { x: wp.x, y: wp.y, z: wp.z });}
      }
    }, 50);
    return true;
  })()`);
  const tier = await c.test<string>(`t.networkManager.transportTier ?? t.networkManager.ws?.tier`);
  // WT_FIRE=1: the soak client fights — real-input fire loop aimed at
  // live remotes, cycling weapon classes. Without this the local
  // prediction→claim→echo path (trajDiv-self, damage echoes, self-shove)
  // stays unmeasured: an AFK client only audits remote replicas.
  if (process.env.WT_FIRE) {
    await c.test(`(() => {
      window.__fire = setInterval(async () => {
        const t = window.__test; const p = t.player;
        if (!p || p.isDead) {return;}
        let best = null, bd = 1e9;
        for (const [id, rp] of (t.world?.remotePlayers ?? [])) {
          const d = p.pos.distanceTo(rp.position);
          if (d < bd) {bd = d; best = rp.position;}
        }
        if (!best || bd < 8 || bd > 220) {return;}
        const { weaponDef } = await import('/src/weapons.ts');
        const wids = [1, 1, 2, 6, 3]; // disc-heavy + chaingun/plasma/mortar
        const wid = wids[Math.floor(Math.random() * wids.length)];
        const def = weaponDef(wid);
        // The server enforces per-weapon cadence — onWeaponFire skips the
        // input cooldown, so the harness must pace itself or every reject
        // is self-inflicted noise.
        const now = performance.now();
        window.__lastFire = window.__lastFire ?? {};
        if (now - (window.__lastFire[wid] ?? -1e9) < def.rate * 1100) {return;}
        window.__lastFire[wid] = now;
        const origin = p.pos.clone().add(new p.pos.constructor(0, 1.4, 0));
        const dir = best.clone().sub(origin);
        dir.y += bd * 0.04; // loft for the arc weapons
        dir.normalize();
        p.onWeaponFire(def, { origin, dir, playerVel: p.vel.clone() });
      }, 400);
      return true;
    })()`);
    console.log('WT_FIRE armed — client firing at remotes');
  }
  console.log(`connected tier=${tier} — soaking ${SECS}s`);
  if (tier !== 'wt') {console.log('WARN: not on wt — check server WT bind log');}
  for (let t = 0; t < SECS; t += 5) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await c.test<Record<string, unknown>>(`({
      tier: t.networkManager.transportTier ?? t.networkManager.ws?.tier,
      conn: t.networkManager.isConnected(),
      ping: Math.round(t.networkManager.telemetry?.ping ?? -1),
      srv: t.networkManager.serverPingMs,
      asym: Math.round(t.networkManager.srvAsymMs ?? 0),
      asymN: t.networkManager.srvAsymN ?? 0,
      laneReconn: t.networkManager.jsonLaneReconnects ?? -1,
      replays: t.networkManager.intentReplays ?? -1,
      resends: t.networkManager.intentResends ?? -1,
      reordC: t.networkManager.wireIn?.reorderCancels ?? -1,
      remotes: [...(t.world?.remotePlayers?.entries?.() ?? [])].map(([id, rp]) => ({
        id: String(id).slice(-6),
        delay: Math.round(rp.renderDelayMs ?? -1),
        ivl: Math.round(rp.interp?.net?.arrivalInterval ?? -1),
        und: rp.interpUnderruns ?? -1,
        capMs: Math.round(rp.interpExtCapMs ?? -1),
        atCap: rp.interp?.net?.atExtCap ? 1 : 0,
      })),
    })`).catch((e) => ({ err: String(e).slice(0, 120) }));
    const rr = (s as Record<string, unknown>).remotes;
    delete (s as Record<string, unknown>).remotes;
    console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(s));
    if (Array.isArray(rr)) {for (const r of rr) console.log('    rp', JSON.stringify(r));}
  }
} finally {
  const jerk = await c.test<Record<string, { d: number[]; pops: number }>>(`(() => {
    const j = window.__jerk; if (j?.timer) {clearInterval(j.timer);}
    if (window.__fire) {clearInterval(window.__fire);}
    const out = {};
    for (const [id, s] of (j?.steps ?? [])) {
      const sorted = [...s.d].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
      out[id] = { n: s.d.length, med: +med.toFixed(2), max: +Math.max(...s.d, 0).toFixed(2),
        pops: s.d.filter((v) => v > Math.max(med * 2.5, 0.6)).length,
        jerks: s.jerk?.length ?? 0,
        buried: s.buried ?? 0, buryMax: s.buryMax ?? 0,
        bWire: s.buriedWire ?? 0, bChord: s.buriedChord ?? 0,
        modelMax: +(s.modelMax ?? 0).toFixed(2),
        ctx: s.popCtx ?? [] };
    }
    const fr = (j.framesMs ?? []).sort((a, b) => a - b);
    out.__fps = { frames: j.frames ?? 0,
      p50: fr[Math.floor(fr.length * 0.5)] ?? 0,
      p95: fr[Math.floor(fr.length * 0.95)] ?? 0 };
    return out;
  })()`).catch(() => null);
  if (jerk) {
    console.log('--- rendered-path jerk (per remote) ---');
    for (const [id, r] of Object.entries(jerk)) {
      if (id === '__fps') {
        console.log(`  sampler health: ticks=${r.frames} p50gap=${r.p50}ms p95gap=${r.p95}ms`);
        continue;
      }
      console.log(`  ${id.slice(-6)}: n=${r.n} medStep=${r.med}m maxStep=${r.max}m pops=${r.pops} jerks=${r.jerks} buried=${r.buried}[w:${r.bWire}/c:${r.bChord}] buryMax=${r.buryMax}m modelDiv=${r.modelMax}m` +
        (r.ctx?.length ? ` ctx=${JSON.stringify(r.ctx)}` : ''));
    }
  }
  for (const b of netbots) { b.bot.stop(); b.nc.close(); }
  console.log('--- netbot telemetry ---');
  for (const { nc } of netbots) {
    const t = nc.tel;
    const rejects = [...t.rejects.entries()].map(([r, n]) => `${r}:${n}`).join(' ') || 'none';
    console.log(`${nc.id}: shots=${t.shots} dealt=${t.hitsDealt} k/d=${t.kills}/${t.deaths} rejects=[${rejects}] corr=${t.corrections} dedup=${t.dedupDrops} rtt=${nc.pingMs}ms${nc.closed ? ` CLOSED[${nc.closeInfo}]` : ''}`);
  }
  const diag = await c.test<Record<string, unknown>>(`window.__trailDump?.() ?? {}`).catch(() => null);
  if (diag) {console.log('--- parity census ---'); for (const [k, v] of Object.entries(diag)) {console.log(`  ${k}: ${JSON.stringify(v).slice(0, 500)}`);}}
  console.log('--- console (session lines) ---');
  for (const l of consoleLines.slice(-40)) console.log(l);
  console.log('--- server tail ---');
  const slog = stack.serverLog();
  console.log(slog.split('\n').slice(-15).join('\n'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync('wtsoak_server.log', slog);
  await closeClient(c);
  stack.down();
}
