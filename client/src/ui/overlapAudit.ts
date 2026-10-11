// HUD overlap audit — a runtime layout lint. There's no static check for
// this: overlap only exists once the browser resolves layout, so we scan
// the rendered chrome (getBoundingClientRect) and report intersecting
// pairs. Runs when the debug view opens, on Alt+Q reveal, and headlessly
// via window.__hudOverlap (the _tools/e2e/overlap.ts spec gates on it).
//
// Scope: top-level chrome only (direct children of #hud or body) that are
// small, positioned, and visible. The <12% viewport-area rule skips the
// canvas, the inset:0 #hud root, modals and menu sidebars — those cover
// the screen BY DESIGN and would flag every row under them.

import Logger from '../core/Logger.js';

const CHROME_ROOTS = '#hud > *, body > *';
const MAX_AREA_FRAC = 0.12; // modal/overlay floor: bigger = intentional cover
const MIN_AREA_PX = 4;

// Exempt by design: canvas is the render surface everything draws over;
// #crosshair and #dmg-dir are the center stack — the damage arc wraps the
// reticle and every center readout on purpose. #altq-toast is a transient
// notification, not chrome (1.5s fade, dismissed by its own timer).
// .player-indicator is a world-space marker — nameplates roam under the
// chrome wherever the camera points; they're scene content, not layout.
const EXEMPT = 'canvas, #crosshair, #dmg-dir, #altq-toast, .player-indicator';

export interface OverlapHit { a: string; b: string; px: number }

function name(el: Element): string {
  if (el.id) {return `#${el.id}`;}
  const cls = [...el.classList][0];
  if (cls) {return `${el.tagName.toLowerCase()}.${cls}`;}
  // Anonymous div — a text snippet beats a bare "div" when reading reports.
  const txt = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 24);
  return `${el.tagName.toLowerCase()}${txt ? `("${txt}")` : ''}`;
}

function isChrome(el: Element, vw: number, vh: number): boolean {
  if (el.matches(EXEMPT)) {return false;}
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') {return false;}
  if (Number.parseFloat(cs.opacity) < 0.05) {return false;} // hidden-by-opacity overlays
  if (cs.display === 'none' || cs.visibility === 'hidden') {return false;}
  if (cs.position !== 'fixed' && cs.position !== 'absolute') {return false;}
  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  return area >= MIN_AREA_PX && area <= vw * vh * MAX_AREA_FRAC;
}

export function auditHudOverlap(): OverlapHit[] {
  const vw = window.innerWidth, vh = window.innerHeight;
  const els = [...document.querySelectorAll(CHROME_ROOTS)]
    .filter((el) => isChrome(el, vw, vh));

  const hits: OverlapHit[] = [];
  for (let i = 0; i < els.length; i += 1) {
    const a = els[i]!;
    const ra = a.getBoundingClientRect();
    for (let j = i + 1; j < els.length; j += 1) {
      const b = els[j]!;
      // Ancestor/descendant pairs are containment, not overlap.
      if (a.contains(b) || b.contains(a)) {continue;}
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 1 && h > 1) {hits.push({ a: name(a), b: name(b), px: Math.round(w * h) });}
    }
  }
  return hits;
}

/** Audit → logger.warn per pair, so violations land in the log panel and
 *  the Alt+Q buffer like every other diagnostic. Returns the count. */
export function reportHudOverlap(): number {
  const hits = auditHudOverlap();
  for (const h of hits) {
    Logger.warn(`HUD overlap: ${h.a} × ${h.b} (${h.px}px²)`);
  }
  return hits.length;
}


declare global {
  interface Window { __hudOverlap?: () => OverlapHit[] }
}

/** Called once at boot — exposes the probe for headless specs. */
export function installOverlapAudit(): void {
  window.__hudOverlap = auditHudOverlap;
}
