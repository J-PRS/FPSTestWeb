// Reveal the in-game HUD on the phone — the overlay only closes on
// pointerlockchange (impossible on touch), so dismiss it + un-hide the
// HUD layer. Run once after the match joins.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
const s = await p.evaluate(`(() => {
  const o = document.getElementById('overlay');
  if (o) { o.style.display = 'none'; }
  document.body.classList.remove('menu-open');
  const hud = document.getElementById('hud');
  if (hud) { hud.style.display = ''; }
  return JSON.stringify({
    overlay: o ? getComputedStyle(o).display : 'none',
    menuOpen: document.body.classList.contains('menu-open'),
    hud: hud ? getComputedStyle(hud).display : 'missing',
    fps: document.querySelector('#hud [id*="fps"], .fps') ? 'found' : 'no-fps-el',
  });
})()`);
console.log(s);
await b.close();
