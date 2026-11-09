// Kill-feed-style battle log for auto-saved cool shots — top-right stack,
// newest on top, entries fade after a few seconds. CS feed, but the
// "weapon icon" is the shot airtime and the timestamp is when it happened.
import { hudRegion } from './hud/regions.js';

const MAX_ENTRIES = 5;
const ENTRY_LIFE_MS = 8000;

let feedEl: HTMLDivElement | null = null;

function feed(): HTMLDivElement {
  if (!feedEl) {
    feedEl = document.createElement('div');
    feedEl.id = 'shot-feed'; // order 3 in the BR region stack (hud.css)
    feedEl.style.cssText = 'display:flex;flex-direction:column-reverse;gap:4px;align-items:flex-end;pointer-events:none;';
    hudRegion('br').append(feedEl);
  }
  return feedEl;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const BASE_CSS = 'position:relative;overflow:hidden;padding:4px 10px;border-radius:4px;background:rgba(10,16,22,0.85);border-left:2px solid rgba(120,200,255,0.8);color:#dfe;font:600 12px/1.2 "Segoe UI",Arial,sans-serif;letter-spacing:0.04em;transition:opacity 0.4s;white-space:nowrap;';

function entry(): HTMLDivElement {
  const f = feed();
  const el = document.createElement('div');
  el.style.cssText = BASE_CSS;
  f.prepend(el);
  while (f.children.length > MAX_ENTRIES) {f.lastElementChild!.remove();}
  return el;
}

function savedText(shotTime: number, airtimeSec: number, chain: number): string {
  return `${fmtTime(shotTime)} — clip saved · ${airtimeSec.toFixed(1)}s air${chain > 1 ? ` x${chain}` : ''}`;
}

function retire(el: HTMLDivElement): void {
  setTimeout((): void => { el.style.opacity = '0'; setTimeout((): void => el.remove(), 400); }, ENTRY_LIFE_MS);
}

/** shotTime = seconds into the recording/match when the shot was fired. */
export function feedShot(shotTime: number, airtimeSec: number, chain = 1): void {
  const el = entry();
  el.textContent = savedText(shotTime, airtimeSec, chain);
  retire(el);
}

export interface PendingFeed {
  /** Clip wait extended (a chained hit landed) — restart the fill. */
  extend(waitSec: number): void;
  /** Extraction finished — flip the entry to "clip saved". */
  done(shotTime: number, airtimeSec: number, chain: number): void;
  /** Clip abandoned (recording stopped/replaced) — remove the toast. */
  discard(): void;
}

/** Toast shown the moment a cool shot is detected; its background fills
 *  over the clip-save wait so the player sees the save is in flight. */
export function feedShotPending(waitSec: number): PendingFeed {
  const el = entry();
  const fill = document.createElement('div');
  fill.style.cssText = 'position:absolute;inset:0;background:rgba(60,140,220,0.30);transform:scaleX(0);transform-origin:left;transition:transform 1s linear;';
  const label = document.createElement('span');
  label.style.position = 'relative';
  label.textContent = 'saving clip…';
  el.append(fill, label);
  const arm = (sec: number): void => {
    fill.style.transitionDuration = `${Math.max(0.2, sec)}s`;
    fill.style.transform = 'scaleX(0)';
    // Force a reflow so the restarted transition always animates from 0.
    fill.getBoundingClientRect();
    fill.style.transform = 'scaleX(1)';
  };
  arm(waitSec);
  return {
    extend(waitSec2: number): void { arm(waitSec2); },
    done(shotTime: number, airtimeSec: number, chain: number): void {
      fill.remove();
      label.textContent = savedText(shotTime, airtimeSec, chain);
      retire(el);
    },
    discard(): void { el.remove(); },
  };
}
