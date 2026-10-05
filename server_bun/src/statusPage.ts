/**
 * statusPage — self-contained ops dashboard served at /status.html.
 * Polls /metrics every 2s and renders: health banner (degraded =
 * quarantined room or tick lag), the tick bandwidth rollup with the
 * per-phase ms bars, per-room rows (players, scores, bot stage CPU,
 * client fps/loss tails, health counters), and session anomalies.
 * Zero deps, zero build — one string, same convention as WEAPONSTATS_PAGE.
 */
export const STATUS_PAGE = `<!doctype html><html><head><meta charset=utf-8>
<title>FPS server status</title>
<style>
body{background:#0d1117;color:#c9d1d9;font:13px/1.4 ui-monospace,monospace;margin:16px}
h1{font-size:16px} h2{font-size:13px;color:#8b949e;margin:18px 0 6px;text-transform:uppercase}
.card{display:inline-block;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;margin:0 8px 8px 0;vertical-align:top}
.card b{display:block;font-size:20px}.card span{color:#8b949e;font-size:11px}
.bad{color:#ff7b72}.warn{color:#d29922}.ok{color:#3fb950}
table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;text-align:left;border-bottom:1px solid #21262d;font-size:12px}
th{color:#8b949e;font-weight:400}
.bar{display:inline-block;background:#238636;height:8px;border-radius:2px;vertical-align:middle;margin-right:4px}
#banner{padding:8px 14px;border-radius:6px;margin-bottom:12px;font-weight:600}
#banner.running{background:#0f2d16;color:#3fb950;border:1px solid #238636}
#banner.degraded{background:#3d1215;color:#ff7b72;border:1px solid #da3633}
</style></head><body>
<div id=banner>connecting…</div>
<div id=cards></div>
<h2>tick phases (ms/tick, last 10s window)</h2><div id=phases></div>
<h2>rooms</h2><div id=rooms></div>
<h2>sessions</h2><div id=sessions></div>
<h2>raw</h2><pre id=raw style="color:#484f58;font-size:11px"></pre>
<script>
const f=(n,d=1)=>n==null?'-':(+n).toFixed(d);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tick(){
 try{const m=await(await fetch('/metrics',{cache:'no-store'})).json();
 const h=await(await fetch('/health',{cache:'no-store'})).json();
 const degraded=h.status!=='running';
 const bn=document.getElementById('banner');
 bn.className=degraded?'degraded':'running';
 bn.textContent=degraded?'DEGRADED — '+(h.quarantined?('quarantined: '+h.quarantined.join(', ')+' '):'')+(h.tickLagMsAvg?('tick lag avg '+h.tickLagMsAvg+'ms'):''):'running · '+h.players+'/'+h.maxPlayers+' players';
 const bw=m.bandwidth||{};
 let cards='';
 const card=(v,l,c)=>{cards+='<div class=card><b class="'+(c||'')+'">'+v+'</b><span>'+l+'</span></div>'};
 card(f((m.uptimeS||0)/60,0)+'m','uptime');
 card(f(bw.kbpsDownTotal,1),'kbps down');
 card(f(bw.recordsPerSec,0),'rec/s');
 card(f(bw.suppressedPerSec,0),'suppressed/s');
 card(f(bw.tierSkippedPerSec,0),'tier-skipped/s');
 card(f(bw.tickFramesDroppedPerSec,0),'frames dropped/s',(bw.tickFramesDroppedPerSec||0)>0?'bad':'ok');
 card(f(bw.tickErrors,0),'tick errors',(bw.tickErrors||0)>0?'bad':'ok');
 card(f(m.tickLagMs&&m.tickLagMs.max,1)+'ms','max tick lag',(m.tickLagMs&&m.tickLagMs.max>10)?'warn':'ok');
 card(f(m.memMB&&m.memMB.heapUsed,0)+'MB','heap');
 card((m.msgsRejected||0),'msgs rejected',(m.msgsRejected||0)>0?'warn':'ok');
 if(m.quarantined&&m.quarantined.length)card(m.quarantined.join(', '),'quarantined','bad');
 document.getElementById('cards').innerHTML=cards;
 const ph=bw.phaseMs||{},tot=Object.values(ph).reduce((a,b)=>a+b,0)||1;
 document.getElementById('phases').innerHTML=Object.entries(ph).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
  '<div><span class=bar style="width:'+Math.max(2,Math.round(v/tot*160))+'px"></span>'+esc(k)+' '+f(v,2)+'</div>').join('')||'—';
 let rows='<tr><th>room</th><th>players</th><th>scores</th><th>bot ms/s (flagGoal·build·think·fire·drive)</th><th>clients</th><th>health</th></tr>';
 for(const r of m.rooms||[]){
  const bm=r.botMs?[r.botMs.flagGoal,r.botMs.build,r.botMs.think,r.botMs.fire,r.botMs.drive].map(v=>f(v,0)).join('·'):'';
  const cs=r.clientStats?('n'+r.clientStats.n+' fps~'+r.clientStats.fpsAvg+'/'+r.clientStats.fpsMin+' loss'+f(r.clientStats.lossMax,0)+'% ping'+r.clientStats.pingMax):'';
  const sc=r.scores?JSON.stringify(r.scores):'';
  const hl=r.health?Object.entries(r.health).map(([k,v])=>k+':'+v).join(' '):'';
  rows+='<tr><td>'+esc(r.name)+(r.mode?' <span style="color:#8b949e">'+esc(r.mode)+'</span>':'')+'</td><td>'+r.players+'</td><td>'+esc(sc)+'</td><td>'+bm+'</td><td>'+esc(cs)+'</td><td>'+esc(hl)+'</td></tr>';
 }
 document.getElementById('rooms').innerHTML='<table>'+rows+'</table>';
 const s=m.sessions||{};
 document.getElementById('sessions').innerHTML=Object.entries(s).map(([k,v])=>'<div class=card><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>').join('')||'—';
 document.getElementById('raw').textContent=JSON.stringify(m,null,1);
 }catch(e){document.getElementById('banner').textContent='server unreachable — '+e;document.getElementById('banner').className='degraded'}
}
tick();setInterval(tick,2000);
</script></body></html>`;
