/**
 * serversPage — public server browser at /servers. Phone-first: big
 * touch cards, no ops data. Polls /rooms + /health (both public-safe:
 * counts only, never names). Zero deps, one string, same convention as
 * STATUS_PAGE/WEAPONSTATS_PAGE.
 */
export const SERVERS_PAGE = `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>FPS servers</title>
<style>
body{background:#0d1117;color:#c9d1d9;font:15px/1.45 system-ui,sans-serif;margin:14px;max-width:560px}
h1{font-size:19px;font-weight:600;margin:0 0 2px}
.sub{color:#8b949e;font-size:12px;margin-bottom:14px}
.room{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;margin:0 0 10px}
.top{display:flex;justify-content:space-between;align-items:baseline}
.name{font-weight:600;font-size:16px}
.badge{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb66;border-radius:20px;padding:1px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.meta{color:#8b949e;font-size:13px;margin-top:2px}
.pips{display:flex;align-items:center;gap:7px;margin-top:8px}
.bar{flex:1;height:8px;background:#21262d;border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;background:#238636;border-radius:4px}
.cnt{font-variant-numeric:tabular-nums;font-weight:600;min-width:56px;text-align:right}
.detail{color:#8b949e;font-size:12px;margin-top:6px;display:flex;justify-content:space-between}
.live{color:#3fb950}.full{color:#ff7b72}
#status{color:#8b949e;font-size:12px;margin-top:16px;text-align:center}
a{color:#58a6ff}
</style></head><body>
<h1>FPS servers</h1>
<div class=sub id=hdr>loading…</div>
<div id=list></div>
<div id=status></div>
<script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const mmss=ms=>{const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
async function tick(){
 try{
  const rooms=await(await fetch('/rooms',{cache:'no-store'})).json();
  const h=await(await fetch('/health',{cache:'no-store'})).json();
  document.getElementById('hdr').textContent=h.players+' online · '+(rooms.length||0)+' rooms · '+location.host;
  if(!rooms.length){document.getElementById('list').innerHTML='<div class=meta>no live rooms — joins mint one instantly</div>';return;}
  document.getElementById('list').innerHTML=rooms.map(r=>{
   const pct=Math.min(100,Math.round(r.players/r.maxPlayers*100));
   const full=r.players>=r.maxPlayers;
   const parts=[];
   if(r.map)parts.push(esc(r.map));
   parts.push(r.humans+' human'+(r.humans===1?'':'s')+(r.players-r.humans>0?' · '+(r.players-r.humans)+' bots':''));
   if(r.spectators)parts.push(r.spectators+' watching');
   const right=[];
   if(r.scores)right.push('α '+r.scores.alpha+' — β '+r.scores.bravo+(r.winAt?' / '+r.winAt:''));
   else if(r.ffaLeader)right.push('leader '+esc(r.ffaLeader[0])+' '+r.ffaLeader[1]+(r.winAt?'/'+r.winAt:''));
   if(r.timeLeftMs)right.push(mmss(r.timeLeftMs)+' left');
   return '<div class=room><div class=top><span class=name>'+esc(r.name)+'</span><span class="badge">'+esc(r.mode||'arena')+'</span></div>'+
    '<div class=meta>'+parts.join(' · ')+'</div>'+
    '<div class=pips><div class=bar><i style="width:'+pct+'%'+(full?';background:#da3633':'')+'"></i></div><span class="cnt '+(full?'full':'live')+'">'+r.players+'/'+r.maxPlayers+'</span></div>'+
    (right.length?'<div class=detail><span>'+right.join('</span><span>')+'</span></div>':'')+
    '</div>';
  }).join('');
  document.getElementById('status').textContent='v'+(h.version||'?')+' · build '+(h.build||'?')+' · '+h.tickRate+'Hz · refreshed '+new Date().toLocaleTimeString();
 }catch(e){document.getElementById('hdr').textContent='server unreachable';}
}
tick();setInterval(tick,5000);
</script></body></html>`;
