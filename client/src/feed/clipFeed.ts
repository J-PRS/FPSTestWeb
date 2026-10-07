// Clip feed — TikTok-style fullscreen replay of the best-shots queue.
// One clip fills the screen; wheel / ↑↓ / swipe moves, space pauses.
// Entry: the /clips route (feedMode.on) or a ?feed flag on dev hosts.
// The world underneath is the normal offline boot — playback reuses the
// production demo-lifecycle wiring; this module is only the chrome + queue.

import type { DemoManager } from '../demo/index.js';
import type { CoolShotEntry } from '../demo/coolShots.js';
import { feedMode } from './feedMode.js';
import { ChildLogger } from '../core/Logger.js';
import type { HUD } from '../ui/hud.js';

const logger = new ChildLogger('ClipFeed');

interface FeedDeps {
  demoManager: DemoManager;
  hud: HUD;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
}

const SLIDE_MS = 220;        // canvas slide in/out — one clip per screen
const NEXT_DELAY_MS = 900;   // linger on the last frame before advancing
const WHEEL_COOLDOWN = 450;  // one notch = one clip; don't stream past
const SWIPE_MIN_PX = 60;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function startClipFeed(d: FeedDeps): Promise<void> {
  const dm = d.demoManager;
  d.hud.hide();
  d.overlay.style.display = 'none';
  document.body.classList.remove('menu-open');

  const root = el('div', '', document.body);
  root.id = 'clipfeed';
  const top = el('div', 'feed-top', root);
  el('span', 'feed-title', top, 'BEST SHOTS');
  const counter = el('span', 'feed-count', top, '');
  const metaCard = el('div', 'feed-meta', root);
  const metaDesc = el('div', 'feed-desc', metaCard);
  const metaStats = el('div', 'feed-stats', metaCard);
  const hint = el('div', 'feed-hint', root, 'scroll · ↑↓ · swipe — next/prev · space — pause · C — hide UI · ESC — exit');
  const rail = el('div', 'feed-rail', root);
  const btnUp = el('button', 'feed-btn', rail, '▲');
  const btnPause = el('button', 'feed-btn', rail, '❚❚');
  const btnDown = el('button', 'feed-btn', rail, '▼');
  const btnShare = el('button', 'feed-btn', rail, '⤴');
  const btnSave = el('button', 'feed-btn', rail, '↓');
  const btnClear = el('button', 'feed-btn', rail, '◌');
  const btnExit = el('button', 'feed-btn', rail, '✕');
  const progress = el('div', 'feed-progress', root);
  const progressFill = el('div', 'feed-progress-fill', progress);
  const empty = el('div', 'feed-empty', root, 'No clips yet — play a round, hit a shot, come back.');

  btnUp.title = 'Previous (↑)';
  btnDown.title = 'Next (↓)';
  btnPause.title = 'Pause (space)';
  btnShare.title = 'Copy clip link';
  btnSave.title = 'Download .demo';
  btnClear.title = 'Hide UI (C)';
  btnExit.title = 'Exit feed (ESC)';

  let entries: CoolShotEntry[] = [];
  let index = 0;
  let wheelLock = 0;
  let advancing = 0;
  let clearScreen = false;
  let touchY: number | null = null;

  const current = (): CoolShotEntry | undefined => entries[index];

  function paintMeta(): void {
    const e = current();
    empty.style.display = e ? 'none' : 'flex';
    if (!e) {
      counter.textContent = '0 / 0';
      metaDesc.textContent = '';
      metaStats.textContent = '';
      return;
    }
    counter.textContent = `${index + 1} / ${entries.length}`;
    metaDesc.textContent = e.description || 'Best shot';
    const bits: string[] = [];
    if (e.weapon) bits.push(e.weapon);
    if (e.distance) bits.push(`${Math.round(e.distance)}m`);
    bits.push(`${e.projectileLifetime.toFixed(2)}s air`);
    if (e.timestamp) bits.push(timeAgo(e.timestamp));
    metaStats.textContent = bits.join(' · ');
    hint.style.opacity = index === 0 ? '1' : '0';
  }

  function updateAddress(): void {
    const e = current();
    if (!e?.filename) {return;}
    // Deep-link follows playback — the address bar always holds the live
    // clip's shareable URL.
    const want = `/clips/${e.filename}`;
    if (window.location.pathname !== want) {
      history.replaceState(null, '', want);
    }
  }

  function slide(dir: 1 | -1): Promise<void> {
    return new Promise((resolve) => {
      const c = d.canvas;
      c.style.transition = `transform ${SLIDE_MS}ms ease, opacity ${SLIDE_MS}ms ease`;
      c.style.transform = `translateY(${dir * -104}%)`;
      c.style.opacity = '0';
      setTimeout(() => {
        resolve();
        // Slide the new clip in from the opposite edge.
        c.style.transform = `translateY(${dir * 104}%)`;
        requestAnimationFrame(() => {
          c.style.transform = 'translateY(0)';
          c.style.opacity = '1';
          setTimeout(() => { c.style.transition = ''; }, SLIDE_MS);
        });
      }, SLIDE_MS);
    });
  }

  function play(i: number): void {
    if (entries.length === 0) {paintMeta(); return;}
    index = ((i % entries.length) + entries.length) % entries.length;
    const e = entries[index]!;
    paintMeta();
    updateAddress();
    dm.playCoolShotById(e.id);
    // Warm the next clip so the swipe lands with no network gap.
    const nxt = entries[(index + 1) % entries.length];
    if (nxt?.filename) {void dm.coolShotMgr.prefetchClip(nxt.filename);}
  }

  async function go(dir: 1 | -1): Promise<void> {
    if (entries.length === 0 || advancing) {return;}
    advancing = dir;
    await slide(dir);
    play(index + dir);
    advancing = 0;
  }

  function scheduleNext(): void {
    setTimeout(() => { if (!advancing) {void go(1);} }, NEXT_DELAY_MS);
  }

  // The lifecycle's own onPlaybackEnd only freezes the last frame — the
  // feed chains the auto-advance behind it.
  const prevEnd = dm.onPlaybackEnd;
  dm.onPlaybackEnd = () => { prevEnd?.(); scheduleNext(); };

  btnUp.addEventListener('click', () => void go(-1));
  btnDown.addEventListener('click', () => void go(1));
  btnPause.addEventListener('click', () => dm.togglePlayPause());
  btnSave.addEventListener('click', () => {
    const e = current();
    if (e) {void dm.downloadCoolShotById(e.id);}
  });
  btnShare.addEventListener('click', () => {
    const e = current();
    if (!e?.filename) {return;}
    void navigator.clipboard?.writeText(`${location.origin}/clips/${e.filename}`)
      .then(() => { btnShare.textContent = '✓'; setTimeout(() => { btnShare.textContent = '⤴'; }, 1200); })
      .catch(() => {});
  });
  const toggleClear = () => {
    clearScreen = !clearScreen;
    root.classList.toggle('feed-clear', clearScreen);
  };
  btnClear.addEventListener('click', toggleClear);
  btnExit.addEventListener('click', () => { window.location.href = '/'; });

  window.addEventListener('wheel', (ev) => {
    const now = performance.now();
    if (Math.abs(ev.deltaY) < 40 || now < wheelLock) {return;}
    wheelLock = now + WHEEL_COOLDOWN;
    void go(ev.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  window.addEventListener('keydown', (ev) => {
    switch (ev.code) {
      case 'ArrowDown': void go(1); break;
      case 'ArrowUp': void go(-1); break;
      case 'Space': ev.preventDefault(); dm.togglePlayPause(); break;
      case 'KeyC': toggleClear(); break;
      case 'Escape': window.location.href = '/'; break;
    }
  });

  window.addEventListener('touchstart', (ev) => { touchY = ev.touches[0]!.clientY; }, { passive: true });
  window.addEventListener('touchend', (ev) => {
    if (touchY === null) {return;}
    const dy = touchY - ev.changedTouches[0]!.clientY;
    touchY = null;
    if (Math.abs(dy) >= SWIPE_MIN_PX) {void go(dy > 0 ? 1 : -1);}
  }, { passive: true });

  // Progress bar + pause icon ride their own rAF — the demo UI's time
  // updates target its hidden transport bar, not the feed.
  const tick = () => {
    const dur = dm.player.duration;
    progressFill.style.width = dur > 0 ? `${(dm.player.currentTimeValue / dur) * 100}%` : '0%';
    btnPause.textContent = dm.mode === 'playing' ? '❚❚' : '▶';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await dm.fetchCoolShotsFromServer();
  entries = dm.getCoolShots();
  logger.info(`Clip feed: ${entries.length} clip(s)`);
  if (feedMode.startAt) {
    const at = entries.findIndex(e => e.filename === feedMode.startAt || e.id === feedMode.startAt);
    if (at >= 0) {index = at;}
    else {logger.warn(`Deep-link clip not on the server: ${feedMode.startAt}`);}
  }
  play(index);
}
