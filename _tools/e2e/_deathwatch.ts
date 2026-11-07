/* oxlint-disable no-console */
// Wire-tap death watcher v3: tap wireIn.message + wireIn.binary (the real
// WS entry points, not dispatch). Records message types and binary
// frame-type histogram; flags playerRespawn/playerKill for the local id.
import { launchClient, closeClient } from './browser.ts';

const SECS = Number(process.argv[2] ?? '120');
const c = await launchClient(
  'http://127.0.0.1:5400/?room=headhunt-1&net=ws&autopilot');
try {
  await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 90000);
  const tap = await c.test(`(() => {
    const nm = window.__test.networkManager;
    const w = nm.wireIn;
    if (!w || w.__tapped) return 'no-wirein';
    window.__wirelog = [];
    const om = w.message.bind(w), ob = w.binary.bind(w);
    w.message = (m) => {
      try { window.__wirelog.push({ lane: 'j', t: m.type, id: m.playerId ?? m.targetId ?? m.id }); } catch {}
      return om(m);
    };
    w.binary = (d) => {
      try { window.__wirelog.push({ lane: 'b', t: 'frame:' + (d && d[1]), n: d && d.length }); } catch {}
      return ob(d);
    };
    w.__tapped = true;
    return 'tapped';
  })()`);
  console.log('tap:', tap);
  const pid = await c.test<any>(`window.__test.networkManager.getLocalPlayerId()`);
  console.log('localPlayerId:', pid, '- idling', SECS, 's');
  const t0 = Date.now();
  let lastDead = false;
  while (Date.now() - t0 < SECS * 1000) {
    const s = await c.test<any>(`JSON.stringify({d: window.__test.player.isDead, h: window.__test.player.health})`);
    const st = JSON.parse(s ?? '{}');
    if (st.d !== lastDead) {console.log(`t+${Math.round((Date.now()-t0)/1000)}s dead=${st.d} hp=${st.h}`); lastDead = st.d;}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const dump = await c.test<any>(`JSON.stringify({
    jtypes: window.__wirelog.filter(m=>m.lane==='j').reduce((a,m)=>(a[m.t]=(a[m.t]||0)+1,a),{}),
    btypes: window.__wirelog.filter(m=>m.lane==='b').reduce((a,m)=>(a[m.t]=(a[m.t]||0)+1,a),{}),
    mine: window.__wirelog.filter(m => m.id === ${JSON.stringify(pid)} || m.t === 'playerRespawn' || m.t === 'playerKill' || m.t === 'matchEnd' || m.t === 'matchNotice').slice(0, 120),
  })`);
  console.log(dump);
} finally {
  await closeClient(c);
}
