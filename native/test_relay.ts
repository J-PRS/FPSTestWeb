const ws = new WebSocket('ws://127.0.0.1:8787/udp');
ws.binaryType = 'arraybuffer';
ws.onopen = () => { ws.send(new Uint8Array([1, 2, 3, 4, 5])); };
ws.onmessage = (ev) => {
  const ab = ev.data as ArrayBuffer;
  console.log('ECHO_BACK:', typeof ev.data, ev.data instanceof ArrayBuffer ? [...new Uint8Array(ab)].join(',') : String(ev.data), 'OK');
  process.exit(0);
};
ws.onerror = (e) => { console.log('ws error', e); process.exit(1); };
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 6000);
