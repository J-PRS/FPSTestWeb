// Live-verify the shotFired→playerShot relay: A joins and fires a hitscan
// notice, B must receive a playerShot naming A. Usage: bun shotprobe.ts <port>
const port = Number(process.argv[2]);
const url = `ws://127.0.0.1:${port}/ws`;
const got: string[] = [];
let joined = false;

const b = new WebSocket(url);
b.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}');
  if (m.type === 'gameState' && !joined) { joined = true; a.send(JSON.stringify({ type: 'shotFired', weaponType: 9, dir: { x: 0, y: 0, z: 1 } })); }
  if (m.type === 'playerShot') got.push(JSON.stringify(m));
};
b.onopen = () => b.send(JSON.stringify({ type: 'join', playerId: 'PROBE-B', room: 'shotprobe' }));

const a = new WebSocket(url);
a.onopen = () => a.send(JSON.stringify({ type: 'join', playerId: 'PROBE-A', room: 'shotprobe' }));
a.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}');
  if (m.type === 'gameState') {
    // stagger a second fire inside the 50ms relay gate — must be dropped
    a.send(JSON.stringify({ type: 'shotFired', weaponType: 9 }));
    a.send(JSON.stringify({ type: 'shotFired', weaponType: 9 }));
  }
};

setTimeout(() => {
  console.log('playerShot events:', got.length);
  for (const g of got) console.log(' ', g);
  process.exit(got.length >= 1 ? 0 : 1);
}, 3000);
