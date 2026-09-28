const ws = new WebSocket('ws://127.0.0.1:9107/ws');
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: 'SPEC-' + Math.floor(Math.random()*1e4), room: 'crossfire', mode: 'ctf', spectate: true }));
ws.onmessage = () => {};
setTimeout(() => { ws.close(); process.exit(0); }, 100000);
