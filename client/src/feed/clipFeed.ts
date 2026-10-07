// Clip feed — TikTok-style fullscreen replay of the best-shots queue.
// One clip fills the screen; wheel / ↑↓ / swipe moves, space pauses.
// Entry: the /clips route (feedMode.on) or a ?feed flag on dev hosts.
// The world underneath is the normal offline boot — playback reuses the
// production demo-lifecycle wiring; this module is only the chrome + queue.

import type { DemoManager } from '../demo/index.js';
import type { CoolShotEntry } from '../demo/coolShots.js';
import type { DemoFile } from '../demo/types.js';
import { feedMode } from './feedMode.js';
import { ChildLogger } from '../core/Logger.js';
import type { HUD } from '../ui/hud.js';

const logger = new ChildLogger('ClipFeed');

interface FeedDeps {
  demoManager: DemoManager;
  hud: HUD;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Same-task render — drawImage of the GL canvas reads a live buffer
   *  only inside the task that rendered it. */
  renderNow?: () => void;
}

const SLIDE_MS = 220;        // canvas slide in/out — one clip per screen
const NEXT_DELAY_MS = 900;   // linger on the last frame before advancing
const WHEEL_COOLDOWN = 450;  // one notch = one clip; don't stream past
// A clip that never reaches 'playing' (evicted server-side, 404, fetch
// failure) emits no onPlaybackEnd, so nothing would advance — the feed
// would wedge on the dead clip forever. Generous so slow fetches of
// legit clips aren't skipped.
const DEAD_CLIP_MS = 10_000;
// Drag commit: either ~1/5 viewport travelled or a real flick. The drag
// itself tracks the finger 1:1 (how TikTok/Reels pagers do it) — a
// threshold-only swipe reads as a canned animation, not a gesture.
const SWIPE_COMMIT_RATIO = 0.18;
const FLICK_V_PX_MS = 0.5;

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
  progress.addEventListener('click', (ev) => {
    const dur = dm.player.duration;
    if (dur <= 0) {return;}
    const rect = progress.getBoundingClientRect();
    dm.player.seek(((ev.clientX - rect.left) / rect.width) * dur);
  });
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
  // Bumped by play() so stale auto-advance/watchdog timers aimed at the
  // previous clip can't act on the current one.
  let clipGen = 0;
  // Finger-tracking drag state — the neighbor mounts at frame 0 under a
  // poster of the outgoing frame; the ring buffer keeps the last ~120ms
  // of samples for flick velocity.
  let drag: {
    startY: number;
    samples: { t: number; y: number }[];
    mounted: boolean; dir: 1 | -1; ni: number;
    savedT: number; wasPlaying: boolean;
    ready: Promise<DemoFile | null> | null;
  } | null = null;

  // ---- Two-pane pager ----
  // TikTok mounts the neighbor's real first frame inside the drag; a
  // single WebGL canvas can't hold two clips, so the outgoing frame is
  // snapshotted to a 2D poster and the live canvas becomes the incoming
  // pane as soon as the drag registers (loaded at frame 0, paused).
  const poster = document.createElement('canvas');
  poster.id = 'clipfeed-poster';
  document.body.appendChild(poster);
  const pctx = poster.getContext('2d')!;

  function snapPoster(): void {
    d.renderNow?.();
    poster.width = d.canvas.width;
    poster.height = d.canvas.height;
    pctx.drawImage(d.canvas, 0, 0);
    poster.style.display = 'block';
    poster.style.transition = 'none';
    poster.style.transform = 'translateY(0px)';
    // Incoming pane: the live canvas parks just offscreen on the neighbor's
    // side, then the whole strip translates — both clips move together.
    d.canvas.style.transition = 'none';
    d.canvas.style.transform = 'translateY(0px)';
  }

  // off = finger travel toward the neighbor (+ up/next, - down/prev).
  function trackPanes(off: number, dir: 1 | -1): void {
    poster.style.transform = `translateY(${-off}px)`;
    d.canvas.style.transform = `translateY(${dir * window.innerHeight - off}px)`;
  }

  function hidePoster(): void {
    poster.style.display = 'none';
    poster.style.transform = '';
    poster.style.transition = '';
    d.canvas.style.transform = '';
    d.canvas.style.transition = '';
  }

  // Spring/landing: both panes ease to their resting offsets together.
  function slidePanes(dir: 1 | -1, commit: boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const vh = window.innerHeight;
      const ease = `transform ${ms}ms ease-out`;
      poster.style.transition = ease;
      d.canvas.style.transition = ease;
      poster.style.transform = `translateY(${commit ? -dir * vh : 0}px)`;
      d.canvas.style.transform = `translateY(${commit ? 0 : dir * vh}px)`;
      setTimeout(resolve, ms);
    });
  }

  const wrapIdx = (i: number): number => ((i % entries.length) + entries.length) % entries.length;
  const resolveClip = (e: CoolShotEntry): Promise<DemoFile | null> => dm.coolShotMgr.resolveClipData(e);

  // Neighbor parked at frame 0 — real pixels under the outgoing poster.
  function mountPaused(data: DemoFile): void {
    dm.onPlaybackStart?.();
    dm.player.load(data);
    dm.player.seek(0);
    dm.onRemotePlayback?.(dm.player.getRemoteStates(), 0);
    dm.setMode('paused');
  }

  function mountPlay(data: DemoFile): void {
    dm.onPlaybackStart?.();
    dm.player.load(data);
    dm.player.seek(0);
    dm.player.play();
    dm.setMode('playing');
  }

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

  function play(i: number, preloaded?: DemoFile | null): void {
    if (entries.length === 0) {paintMeta(); return;}
    index = wrapIdx(i);
    clipGen++;
    const e = entries[index]!;
    paintMeta();
    updateAddress();
    if (preloaded) {mountPlay(preloaded);}
    else {dm.playCoolShotById(e.id);}
    // Dead-clip watchdog — fire-and-forget playback gives no failure
    // signal, so a clip that never starts gets skipped on a timer.
    const g = clipGen;
    setTimeout(() => {
      if (g === clipGen && dm.mode !== 'playing' && dm.mode !== 'paused') {void go(1);}
    }, DEAD_CLIP_MS);
    // Warm the next clip so the swipe lands with no network gap.
    const nxt = entries[wrapIdx(index + 1)];
    if (nxt?.filename) {void dm.coolShotMgr.prefetchClip(nxt.filename);}
  }

  async function go(dir: 1 | -1): Promise<void> {
    if (entries.length === 0 || advancing) {return;}
    advancing = dir;
    snapPoster();
    dm.player.pause();
    const e = entries[wrapIdx(index + dir)]!;
    const data = await resolveClip(e);
    if (data) {mountPaused(data);}
    trackPanes(0, dir);
    await slidePanes(dir, true, SLIDE_MS);
    hidePoster();
    play(index + dir, data);
    advancing = 0;
  }

  function scheduleNext(): void {
    // Generation-guarded: a swipe/keys into the next clip inside the
    // window would otherwise let the stale timer advance AGAIN and
    // double-skip. Also yields to a manual seek/pause — either means
    // the user took the wheel.
    const g = clipGen;
    setTimeout(() => {
      if (advancing || g !== clipGen) {return;}
      // 'paused' is overloaded: manual pause (hold the feed) AND the mode
      // natural end leaves — the lifecycle parks the clock at duration,
      // so end-of-clip must still advance while a mid-clip pause holds.
      const parkedAtEnd = dm.player.duration > 0 && dm.player.currentTimeValue >= dm.player.duration;
      if (dm.mode === 'playing' || (dm.mode === 'paused' && !parkedAtEnd)) {return;}
      void go(1);
    }, NEXT_DELAY_MS);
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
  // Auto-routed (touch) exits keep the ?play opt-out so they don't loop
  // back into the feed; URL-routed exits drop to / normally.
  const exitTo = feedMode.auto ? '/?play' : '/';
  btnExit.addEventListener('click', () => { window.location.href = exitTo; });

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
      case 'Escape': window.location.href = exitTo; break;
    }
  });

  // Tracked drag: the canvas follows the finger (translate only, no
  // transition), then commits past ~18% viewport or a flick and springs
  // back otherwise. touch-action:none is set while the feed runs so the
  // browser doesn't fight the gesture with pull-to-refresh.
  d.canvas.style.touchAction = 'none';
  window.addEventListener('touchstart', (ev) => {
    if (entries.length === 0 || advancing) {return;}
    drag = {
      startY: ev.touches[0]!.clientY,
      samples: [{ t: performance.now(), y: ev.touches[0]!.clientY }],
      mounted: false, dir: 1, ni: index, savedT: 0, wasPlaying: false, ready: null,
    };
  }, { passive: true });
  window.addEventListener('touchmove', (ev) => {
    if (!drag) {return;}
    const y = ev.touches[0]!.clientY;
    drag.samples.push({ t: performance.now(), y });
    if (drag.samples.length > 8) {drag.samples.shift();}
    const dy = drag.startY - y; // + = swiping up = next clip
    // Mount the neighbor on first meaningful travel — its frame-0 tracks
    // in with the finger, like TikTok's pager, instead of sliding blank.
    if (!drag.mounted && Math.abs(dy) > 12) {
      drag.mounted = true;
      drag.dir = dy >= 0 ? 1 : -1;
      drag.ni = wrapIdx(index + drag.dir);
      drag.savedT = dm.player.currentTimeValue;
      drag.wasPlaying = dm.mode === 'playing';
      snapPoster();
      dm.player.pause();
      dm.setMode('paused');
      const e = entries[drag.ni]!;
      const mountedDrag = drag;
      drag.ready = resolveClip(e).then((data) => {
        if (data && drag === mountedDrag) {mountPaused(data);}
        return data;
      });
    }
    if (drag.mounted) {
      const off = Math.max(-window.innerHeight, Math.min(window.innerHeight, dy));
      trackPanes(off, drag.dir);
    }
  }, { passive: true });
  window.addEventListener('touchend', (ev) => {
    if (!drag) {return;}
    const d0 = drag;
    drag = null;
    const endY = ev.changedTouches[0]!.clientY;
    const dy = d0.startY - endY;
    // Flick velocity from the recent sample window — a short fast fling
    // commits even when the travel was small.
    const now = performance.now();
    const s0 = d0.samples.find(s => now - s.t <= 120) ?? d0.samples[0]!;
    const v = now > s0.t ? (s0.y - endY) / (now - s0.t) : 0; // px/ms, + = up
    const dir: 1 | -1 = (Math.abs(v) > 0.01 ? v : dy) >= 0 ? 1 : -1;
    if (!d0.mounted || advancing) {return;} // tap — nothing mounted
    const commit = Math.abs(dy) > window.innerHeight * SWIPE_COMMIT_RATIO || Math.abs(v) > FLICK_V_PX_MS;
    if (commit && dir === d0.dir) {
      advancing = dir;
      const ni = d0.ni;
      void (async () => {
        await slidePanes(dir, true, SLIDE_MS);
        hidePoster();
        const data = await d0.ready;
        play(ni, data);
        advancing = 0;
      })();
    } else {
      // Spring back — restore the outgoing clip where the drag found it.
      void (async () => {
        await slidePanes(d0.dir, false, SLIDE_MS);
        hidePoster();
        const e = current();
        const data = e ? await resolveClip(e) : null;
        if (data) {
          dm.onPlaybackStart?.();
          dm.player.load(data);
          dm.player.seek(d0.savedT);
          dm.onRemotePlayback?.(dm.player.getRemoteStates(), 0);
          if (d0.wasPlaying) {dm.player.play(); dm.setMode('playing');}
        } else {
          play(index);
        }
      })();
    }
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
