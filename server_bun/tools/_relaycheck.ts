for (const path of ['/ws', '/rtc?room=abc', '/rtcs']) {
  const ws = new WebSocket(`ws://localhost:8000${path}`);
  ws.onopen = () => { console.log(path, 'OPEN'); ws.close(); };
  ws.onerror = () => console.log(path, 'ERR');
  ws.onclose = (e) => console.log(path, 'CLOSE', e.code, e.reason);
}
await new Promise(r => setTimeout(r, 3000));
