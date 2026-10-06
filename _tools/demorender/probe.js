const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--window-size=1280,800', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  p.on('console', m => { const t = m.text(); if (/error|fail|webgl|warn/i.test(t)) console.log('[console]', t.slice(0, 200)); });
  await p.goto('http://localhost:5400/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 6000));
  await p.screenshot({ path: '/tmp/probe.png' });
  const info = await p.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return { canvas: !!c, w: c?.width, h: c?.height, gl: !!gl, dm: !!window.__demoManager, rec: window.__demoManager?.isRecording, bodyHtml: document.body.innerHTML.length, canvases: document.querySelectorAll('canvas').length };
  });
  console.log(JSON.stringify(info));
  // also wait for recording then probe again
  try {
    await p.waitForFunction('window.__demoManager && window.__demoManager.isRecording === true', { timeout: 15000 });
    console.log('recording flag reached');
    await p.screenshot({ path: '/tmp/probe2.png' });
  } catch { console.log('recording flag never reached'); }
  await b.close();
})();
