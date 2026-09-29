/**
 * weaponstatsPage — human-readable balance dashboard at /weaponstats.html.
 * Self-contained HTML that fetches /weaponstats and renders the ledger:
 * per-mode weapon rows, duel TTK, kill speeds + air share, flag timers,
 * death heatmap cells, and the pickup funnel. No framework, no build.
 */
export const WEAPONSTATS_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>weaponstats — KRIBES balance ledger</title><meta name="viewport" content="width=device-width">
<style>
body{background:#0b0e14;color:#dfe6f0;font:13px/1.45 system-ui,sans-serif;margin:0;padding:20px;max-width:1100px}
h1{font-size:18px;margin:0 0 2px}
h2{font-size:13px;color:#8fd0ff;margin:20px 0 6px;text-transform:uppercase;letter-spacing:.08em}
h3{font-size:12px;color:#9fb2c8;margin:12px 0 4px}
table{border-collapse:collapse;margin:6px 0}
th,td{padding:3px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px;white-space:nowrap}
th{color:#7a8aa0;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.05em;border-bottom:1px solid #232c3d}
td{border-bottom:1px solid #141a26}
td.l,th.l{text-align:left}
.bar{display:inline-block;height:9px;background:#3d6ea5;border-radius:2px;vertical-align:middle}
.mut{color:#5b6b80}.hot{color:#ffb066}.ok{color:#8fd08f}
.grid{display:flex;flex-wrap:wrap;gap:18px}
a{color:#8fd0ff}
</style></head><body>
<h1>Balance ledger</h1>
<p class="mut">Live snapshot of <a href="/weaponstats">/weaponstats</a> — accumulated since last restart; also journaled to logs/weaponstats.jsonl. <span id="ts"></span></p>
<div id="out">loading…</div>
<script>
const fmt=(n,d=0)=>n.toLocaleString(undefined,{maximumFractionDigits:d});
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
fetch('/weaponstats').then(r=>r.json()).then(d=>{
  document.getElementById('ts').textContent='fetched '+new Date().toLocaleTimeString();
  const out=document.getElementById('out'); out.innerHTML='';
  const modes=Object.keys(d.byMode||{});
  if(!modes.length){out.innerHTML='<p class="mut">No combat recorded yet — play a match.</p>';return}
  for(const mode of modes){
    const h=[];
    h.push('<h2>mode: '+esc(mode)+'</h2>');
    // weapons
    const rows=Object.entries(d.byMode[mode]).sort((a,b)=>b[1].damage-a[1].damage);
    const maxD=Math.max(1,...rows.map(r=>r[1].damage));
    h.push('<h3>weapons (damage / hits / kills / bot share)</h3><table><tr><th class="l">source</th><th>hits</th><th>damage</th><th>kills</th><th>botDmg%</th><th></th></tr>');
    for(const [s,r] of rows){
      const botPct=r.damage?Math.round(100*r.botDamage/r.damage):0;
      h.push('<tr><td class="l">'+esc(s)+'</td><td>'+fmt(r.hits)+'</td><td>'+fmt(r.damage)+'</td><td>'+fmt(r.kills)+'</td><td class="'+(botPct>90?'mut':'ok')+'">'+botPct+'%</td><td><span class="bar" style="width:'+Math.round(120*r.damage/maxD)+'px"></span></td></tr>');
    }
    h.push('</table>');
    // ttk
    const tk=d.ttk?.[mode]||{};
    if(Object.keys(tk).length){
      h.push('<h3>duel TTK (first-hit &rarr; kill)</h3><table><tr><th class="l">source</th><th>n</th><th>avg s</th></tr>');
      for(const [s,r] of Object.entries(tk).sort((a,b)=>a[1].totalMs/a[1].n-b[1].totalMs/b[1].n))
        h.push('<tr><td class="l">'+esc(s)+'</td><td>'+r.n+'</td><td>'+fmt(r.totalMs/r.n/1000,1)+'</td></tr>');
      h.push('</table>');
    }
    // speeds + air share
    const sp=d.speeds?.[mode];
    if(sp){
      const total=Object.values(sp.victim).reduce((a,b)=>a+b,0);
      h.push('<h3>kill-moment speed (m/s buckets) — '+fmt(100*sp.airShooter/total)+'% air shooters / '+fmt(100*sp.airVictim/total)+'% air victims</h3><div class="grid">');
      for(const side of ['shooter','victim']){
        const bins=Object.entries(sp[side]).sort((a,b)=>(+a[0]||0)-(+b[0]||0));
        const mx=Math.max(1,...bins.map(b=>b[1]));
        h.push('<table><tr><th class="l">'+side+'</th><th></th></tr>');
        for(const [b,n] of bins) h.push('<tr><td class="l">'+esc(b)+'–'+(+b+5)+'</td><td><span class="bar" style="width:'+Math.round(80*n/mx)+'px"></span> '+n+'</td></tr>');
        h.push('</table>');
      }
      h.push('</div>');
    }
    // deaths
    const dt=d.deaths?.[mode]||{};
    if(Object.keys(dt).length){
      const cells=Object.entries(dt).sort((a,b)=>b[1]-a[1]);
      h.push('<h3>death heat cells (top 15, 10m grid)</h3><table><tr><th class="l">cell (x,z)</th><th>deaths</th></tr>');
      for(const [c,n] of cells.slice(0,15)) h.push('<tr><td class="l">'+esc(c)+'</td><td>'+n+'</td></tr>');
      h.push('</table>');
    }
    // flags
    const fl=d.flags?.[mode];
    if(fl&&(fl.caps||fl.returns))
      h.push('<h3>flags</h3><table><tr><th>caps</th><th>avg hold s</th><th>returns</th><th>avg drop s</th></tr><tr><td>'+fl.caps+'</td><td>'+fmt(fl.caps?fl.holdMs/fl.caps/1000:0,1)+'</td><td>'+fl.returns+'</td><td>'+fmt(fl.returns?fl.dropMs/fl.returns/1000:0,1)+'</td></tr></table>');
    // deployables — placements cross-read against 'X hit' damage rows
    const dp=d.deploys?.[mode]||{};
    if(Object.keys(dp).length){
      const byMode=d.byMode[mode]||{};
      h.push('<h3>deployables</h3><table><tr><th class="l">kind</th><th>placed</th><th>kills</th><th>kills/plant</th></tr>');
      for(const [k,n] of Object.entries(dp)){
        const kills=(byMode[k==='turret'?'Turret hit':k==='mine'?'Mine hit':'']?.kills)||0;
        h.push('<tr><td class="l">'+esc(k)+'</td><td>'+n+'</td><td>'+kills+'</td><td>'+fmt(kills/n,2)+'</td></tr>');
      }
      h.push('</table>');
    }
    // pickups
    const pk=d.pickups?.[mode]||{};
    if(Object.keys(pk).length){
      h.push('<h3>pickup funnel</h3><table><tr><th class="l">kind</th><th>spawned</th><th>banked</th><th>decayed</th><th>bank%</th></tr>');
      for(const [k,r] of Object.entries(pk)){
        const pct=r.spawned?Math.round(100*r.banked/r.spawned):0;
        h.push('<tr><td class="l">'+esc(k)+'</td><td>'+r.spawned+'</td><td>'+r.banked+'</td><td>'+r.decayed+'</td><td class="'+(pct<40?'hot':'ok')+'">'+pct+'%</td></tr>');
      }
      h.push('</table>');
    }
    const div=document.createElement('div'); div.innerHTML=h.join(''); out.appendChild(div);
  }
}).catch(e=>{document.getElementById('out').innerHTML='<p class="hot">fetch failed: '+esc(e)+'</p>'});
</script></body></html>`;
