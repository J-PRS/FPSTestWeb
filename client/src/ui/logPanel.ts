// In-game log mirror — a small scrolling console in the bottom-right so
// warnings/errors are visible without opening devtools. Shows with the
// backquote debug overlay or an Alt+Q peek (which also copies the buffer).
// The menu DEBUG toggle is visuals-only (wireframes/gizmos) and must NOT
// pull this panel in. Lines come live off Logger's lineListener; while
// hidden nothing is appended — the panel reseeds from the ring buffer on
// show so storms never do DOM work nobody can see.

import { Logger, LogLevel } from '../core/Logger.js';
import { hudRegion } from './hud/regions.js';

const MAX_LINES = 150;

let panel: HTMLDivElement | null = null;
let body: HTMLDivElement | null = null;
let overlay = false;   // backquote debug view drives this
let stick = true;      // autoscroll tail unless the user scrolled up

const LEVEL_CLASS: Partial<Record<LogLevel, string>> = {
  [LogLevel.DEBUG]: 'dbg',
  [LogLevel.WARN]: 'wrn',
  [LogLevel.ERROR]: 'err',
};

// Seeded lines come back as plain strings — the level lives in the
// `[LEVEL]` marker each writer stamps (logger and the console wrapper).
function levelOf(line: string): LogLevel {
  const m = line.match(/\[(ERROR|WARN|INFO|DEBUG|LOG)\]/);
  if (!m) {return LogLevel.INFO;}
  if (m[1] === 'ERROR') {return LogLevel.ERROR;}
  if (m[1] === 'WARN') {return LogLevel.WARN;}
  if (m[1] === 'DEBUG' || m[1] === 'LOG') {return LogLevel.DEBUG;}
  return LogLevel.INFO;
}

function appendLine(line: string, level: LogLevel): void {
  if (!body || !panel!.classList.contains('show')) {return;}
  const div = document.createElement('div');
  div.className = `lp-line ${LEVEL_CLASS[level] ?? 'inf'}`;
  div.textContent = line;
  body.append(div);
  while (body.childElementCount > MAX_LINES) {body.firstElementChild!.remove();}
  if (stick) {body.scrollTop = body.scrollHeight;}
}

function reseed(): void {
  if (!body) {return;}
  body.textContent = '';
  stick = true;
  for (const line of Logger.getLogs().slice(-MAX_LINES)) {
    const div = document.createElement('div');
    div.className = `lp-line ${LEVEL_CLASS[levelOf(line)] ?? 'inf'}`;
    div.textContent = line;
    body.append(div);
  }
  body.scrollTop = body.scrollHeight;
}

function syncVisible(): void {
  if (!panel) {return;}
  const show = overlay;
  const was = panel.classList.contains('show');
  panel.classList.toggle('show', show);
  if (show && !was) {reseed();}
}

function ensurePanel(): void {
  if (panel) {return;}
  panel = document.createElement('div');
  panel.id = 'log-panel';

  const head = document.createElement('div');
  head.className = 'lp-head';
  head.textContent = 'LOG';

  body = document.createElement('div');
  body.className = 'lp-body';
  body.addEventListener('scroll', (): void => {
    // Re-stick only when scrolled back to the tail — new lines must not
    // yank a review scroll back to the bottom.
    stick = body!.scrollTop + body!.clientHeight >= body!.scrollHeight - 8;
  });

  panel.append(head, body);
  hudRegion('br').append(panel);
}

/** Backquote debug overlay — same visibility contract as stats/perfHud. */
export function setLogOverlayVisible(show: boolean): void {
  overlay = show;
  ensurePanel();
  syncVisible();
}

export function initLogPanel(): void {
  ensurePanel();
  Logger.setLineListener(appendLine);
  syncVisible();
}
