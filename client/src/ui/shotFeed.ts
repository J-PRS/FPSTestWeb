// Kill-feed-style battle log for auto-saved cool shots — top-right stack,
// newest on top, entries fade after a few seconds. CS feed, but the
// "weapon icon" is the shot airtime and the timestamp is when it happened.

const MAX_ENTRIES = 5;
const ENTRY_LIFE_MS = 8000;

let feedEl: HTMLDivElement | null = null;

function feed(): HTMLDivElement {
  if (!feedEl) {
    feedEl = document.createElement('div');
    feedEl.id = 'shot-feed'; // id so hud.css can re-anchor it above the log panel
    feedEl.style.cssText = 'position:fixed;bottom:var(--z-br-2);right:16px;display:flex;flex-direction:column-reverse;gap:4px;align-items:flex-end;z-index:99990;pointer-events:none;';
    document.body.append(feedEl);
  }
  return feedEl;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** shotTime = seconds into the recording/match when the shot was fired. */
export function feedShot(shotTime: number, airtimeSec: number, chain = 1): void {
  const f = feed();
  const el = document.createElement('div');
  el.style.cssText = 'padding:4px 10px;border-radius:4px;background:rgba(10,16,22,0.85);border-left:2px solid rgba(120,200,255,0.8);color:#dfe;font:600 12px/1.2 "Segoe UI",Arial,sans-serif;letter-spacing:0.04em;transition:opacity 0.4s;white-space:nowrap;';
  el.textContent = `${fmtTime(shotTime)} — clip saved · ${airtimeSec.toFixed(1)}s air${chain > 1 ? ` x${chain}` : ''}`;
  f.prepend(el);
  while (f.children.length > MAX_ENTRIES) {f.lastElementChild!.remove();}
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, ENTRY_LIFE_MS);
}
