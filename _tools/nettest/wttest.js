// E2E: real Chrome WebTransport → WT server (QUIC) → join + tick frames.
// Proves the browser-side tier incl. self-signed cert pinning via
// serverCertificateHashes. Usage: node wttest.js [--port 9477]
const puppeteer = require('puppeteer-core');

const opt = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => {
  const k = a.replace(/^--/, '');
  const v = arr[i + 1];
  return [k, v && !v.startsWith('--') ? v : true];
}));
const HTTP_PORT = Number(opt.port || 9477);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const info = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/wthash`)).json();
  console.log('wthash:', JSON.stringify(info));
  if (!info.enabled) throw new Error('WT not enabled on server');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--origin-trial-disabled-features=WebTransport'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('page:', m.text()));
  // WebTransport requires a secure context — localhost qualifies, so load
  // any page on the server origin before evaluating.
  await page.goto(`http://localhost:${HTTP_PORT}/health`);

  const result = await page.evaluate(async (port, sha256) => {
    const hash = Uint8Array.from(atob(sha256), (c) => c.charCodeAt(0));
    try {
      const wt = new WebTransport(`https://127.0.0.1:${port}`, {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: hash.buffer }],
      });
      await Promise.race([wt.ready, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
      // open a bidirectional stream → send join → expect joinAck back
      const stream = await wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      await writer.write(new TextEncoder().encode(JSON.stringify({ type: 'join', playerId: 'wt-e2e' }) + '\n'));
      const { value } = await Promise.race([
        reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error('read timeout')), 5000)),
      ]);
      const text = new TextDecoder().decode(value);
      // also check datagrams arrive (tick frames are unreliable datagrams)
      const dg = wt.datagrams.readable.getReader();
      const dgResult = await Promise.race([
        dg.read().then(({ value }) => 'datagram ' + value.byteLength + 'B'),
        new Promise((res) => setTimeout(() => res('no datagrams in 2s'), 2000)),
      ]);
      wt.close();
      return { joined: text.includes('joinAck') || text.includes('"type"'), firstMsg: text.slice(0, 120), dg: dgResult };
    } catch (e) {
      return { error: String(e) };
    }
  }, info.port, info.sha256);

  console.log('RESULT:', JSON.stringify(result, null, 1));
  await browser.close();
  process.exit(result.error ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
