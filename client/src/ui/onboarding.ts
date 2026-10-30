/**
 * Mobile gate: no keyboard/mouse = the game is unplayable, better to
 * say so than render a broken page. DOM-only; the game keeps booting
 * underneath.
 */

const SKIP_KEY = 'fps-nomobile';

const card = (title: string, body: string, btnText: string | null): HTMLDivElement => {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(6,10,18,0.82);backdrop-filter:blur(4px);';
  const box = document.createElement('div');
  box.style.cssText =
    'max-width:420px;padding:26px 30px;border:1px solid rgba(58,167,255,0.35);border-radius:8px;' +
    'background:rgba(8,14,24,0.95);color:#cfe3ff;font:14px/1.6 monospace;text-align:center;';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:1.15rem;letter-spacing:0.18em;color:#3aa7ff;margin-bottom:14px;';
  h.textContent = title;
  const p = document.createElement('div');
  p.style.cssText = 'text-align:left;white-space:pre-line;';
  p.textContent = body;
  box.append(h, p);
  if (btnText) {
    const b = document.createElement('button');
    b.textContent = btnText;
    b.style.cssText =
      'margin-top:18px;padding:8px 26px;font:inherit;letter-spacing:0.14em;cursor:pointer;' +
      'color:#eaf4ff;background:rgba(58,167,255,0.16);border:1px solid rgba(58,167,255,0.5);border-radius:4px;';
    b.addEventListener('click', (): void => {
      // Persist the bypass - a phone tester shouldn't re-dismiss every
      // reload. Clear via devtools localStorage or a desktop boot.
      try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* private mode */ }
      el.remove();
    });
    box.append(b);
  }
  el.append(box);
  return el;
};

export function wireOnboarding(): void {
  // Coarse pointer with no fine fallback = phone/tablet. The game needs
  // a keyboard+mouse; a broken render is a worse first impression than
  // an honest gate. Checked live so a hybrid laptop with a mouse passes.
  // ?nomobile=1 skips it entirely - real-device profiling needs to see
  // the game render on a phone, gate or no gate.
  const touchOnly = window.matchMedia('(pointer: coarse)').matches
    && !window.matchMedia('(pointer: fine)').matches;
  const skipped = new URLSearchParams(location.search).has('nomobile')
    || localStorage.getItem(SKIP_KEY) === '1';
  if (touchOnly && !skipped) {
    document.body.append(card(
      'DESKTOP REQUIRED',
      'This game needs a keyboard and mouse.\n\nCome back on a laptop or desktop -\nphone/tablet controls are not supported yet.',
      'VIEW ANYWAY',
    ));
  }
}
