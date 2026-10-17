self.onmessage = (e) => {
  if (!e.data || !e.data.url) return;
  const ws = new WebSocket(e.data.url);
  const t = setTimeout(() => self.postMessage({ r: 'timeout', rs: ws.readyState }), e.data.ms || 6000);
  ws.onopen = () => { clearTimeout(t); self.postMessage({ r: 'open' }); };
  ws.onerror = () => { clearTimeout(t); self.postMessage({ r: 'error' }); };
  ws.onclose = (ev) => { clearTimeout(t); self.postMessage({ r: 'close', code: ev.code }); };
};
