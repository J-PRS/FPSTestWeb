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
  if (cls) {e.className = cls;}
  if (text !== undefined) {e.textContent = text;}
  parent.append(e);
  return e;
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) {return `${secs}s ago`;}
  const mins = Math.floor(secs / 60);
  if (mins < 60) {return `${mins}m ago`;}
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {return `${hrs}h ago`;}
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
  progress.addEventListener('click', (ev): void => {
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
  // Finger-tracking drag state — the live canvas stays on the OUTGOING
  // clip the whole gesture (it keeps playing, mid-slide included); the
  // poster is the incoming pane. The ring buffer keeps the last ~120ms
  // of samples for flick velocity.
  let drag: {
    startY: number;
    samples: { t: number; y: number }[];
    mounted: boolean; dir: 1 | -1; ni: number;
    ready: Promise<DemoFile | null> | null;
  } | null = null;

  // ---- Two-pane pager ----
  // A single WebGL canvas can't render two clips, so the pane roles are
  // fixed: canvas = outgoing (live, translating as it exits), poster =
  // incoming — a meta placeholder during the drag, then the real paused
  // frame painted on it once the commit mounts the clip.
  const poster = document.createElement('canvas');
  poster.id = 'clipfeed-poster';
  document.body.append(poster);
  const pctx = poster.getContext('2d')!;

  // Placeholder card for the incoming pane — a real frame would require
  // swapping the world mid-drag, which is exactly the mount hitch the
  // deferred-mirror design avoids. Meta reads like the feed's own card.
  function paintPlaceholder(e: CoolShotEntry): void {
    poster.width = d.canvas.width;
    poster.height = d.canvas.height;
    const w = poster.width, h = poster.height;
    pctx.fillStyle = '#0a0e12';
    pctx.fillRect(0, 0, w, h);
    pctx.textAlign = 'center';
    pctx.fillStyle = 'rgba(255,255,255,0.85)';
    pctx.font = `${Math.round(h * 0.045)}px monospace`;
    pctx.fillText(e.description || 'Best shot', w / 2, h / 2 - h * 0.03, w * 0.9);
    const bits: string[] = [];
    if (e.weapon) {bits.push(e.weapon);}
    if (e.distance) {bits.push(`${Math.round(e.distance)}m`);}
    bits.push(`${e.projectileLifetime.toFixed(2)}s air`);
    pctx.fillStyle = 'rgba(120,200,255,0.8)';
    pctx.font = `${Math.round(h * 0.032)}px monospace`;
    pctx.fillText(bits.join('  ·  '), w / 2, h / 2 + h * 0.03, w * 0.9);
    poster.style.display = 'block';
    poster.style.transition = 'none';
    d.canvas.style.transition = 'none';
  }

  // The game canvas is centered via inline transform (left/top 50% +
  // translate(-50%,-50%)) — every transform write here MUST keep that
  // prefix or the canvas collapses to a bottom-right quadrant on narrow
  // windows (the 16:9 overscan is wider than a portrait viewport).
  const CENTER = 'translate(-50%, -50%)';
  const centered = (y: number): string => `${CENTER} translateY(${y}px)`;

  // off = finger travel toward the neighbor (+ up/next, - down/prev).
  function trackPanes(off: number, dir: 1 | -1): void {
    d.canvas.style.transform = centered(-off);
    poster.style.transform = `translateY(${dir * window.innerHeight - off}px)`;
  }

  function hidePoster(): void {
    poster.style.display = 'none';
    poster.style.transform = '';
    poster.style.transition = '';
    d.canvas.style.transform = CENTER;
    d.canvas.style.transition = '';
  }

  // Spring/landing: both panes ease to their resting offsets together.
  function slidePanes(dir: 1 | -1, commit: boolean, ms: number): Promise<void> {
    return new Promise((resolve): void => {
      const vh = window.innerHeight;
      const ease = `transform ${ms}ms ease-out`;
      poster.style.transition = ease;
      d.canvas.style.transition = ease;
      d.canvas.style.transform = centered(commit ? -dir * vh : 0);
      poster.style.transform = `translateY(${commit ? 0 : dir * vh}px)`;
      setTimeout(resolve, ms);
    });
  }

  const wrapIdx = (i: number): number => ((i % entries.length) + entries.length) % entries.length;
  // Never rejects: IDB/read failures and corrupt blobs all degrade to a
  // plain miss — a throw inside a pager transition would strand
  // `advancing` with the poster frozen over the feed.
  const resolveClip = (e: CoolShotEntry): Promise<DemoFile | null> =>
    dm.coolShotMgr.resolveClipData(e).catch((): null => null);

  function mountPlay(data: DemoFile): boolean {
    try {
      dm.onPlaybackStart?.();
      dm.player.load(data);
      dm.player.seek(0);
      dm.player.play();
      dm.setMode('playing');
      return true;
    } catch { return false; }
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
    if (e.weapon) {bits.push(e.weapon);}
    if (e.distance) {bits.push(`${Math.round(e.distance)}m`);}
    bits.push(`${e.projectileLifetime.toFixed(2)}s air`);
    if (e.timestamp) {bits.push(timeAgo(e.timestamp));}
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
clipGen += 1;
    const e = entries[index]!;
    paintMeta();
    updateAddress();
    if (preloaded && mountPlay(preloaded)) {
      // mounted above
    } else {dm.playCoolShotById(e.id);}
    // Dead-clip watchdog — fire-and-forget playback gives no failure
    // signal, so a clip that never starts gets skipped on a timer.
    const g = clipGen;
    setTimeout((): void => {
      if (g === clipGen && dm.mode !== 'playing' && dm.mode !== 'paused') {go(1);}
    }, DEAD_CLIP_MS);
    // Warm the next clip so the swipe lands with no network gap.
    const nxt = entries[wrapIdx(index + 1)];
    if (nxt?.filename) {dm.coolShotMgr.prefetchClip(nxt.filename);}
  }

  // Shared commit tail: slide the playing clip out, swap the canvas to
  // the new clip behind the covering poster, then reveal.
  async function commitAdvance(dir: 1 | -1, ni: number, ready: Promise<DemoFile | null>): Promise<void> {
    await slidePanes(dir, true, SLIDE_MS);
    // Canvas lands at 0 behind the placeholder poster — invisible swap.
    d.canvas.style.transition = 'none';
    d.canvas.style.transform = CENTER;
    const data = await ready;
    play(ni, data);
    // Let one real frame render beneath the placeholder before reveal.
    requestAnimationFrame((): void => hidePoster());
  }

  async function go(dir: 1 | -1): Promise<void> {
    if (entries.length === 0 || advancing) {return;}
    // An auto-advance/keys/wheel go() can land mid-gesture — cancel the
    // drag outright or touchend's commit path advances a second clip.
    drag = null;
    advancing = dir;
    const ni = wrapIdx(index + dir);
    const e = entries[ni]!;
    paintPlaceholder(e);
    poster.style.transform = `translateY(${dir * window.innerHeight}px)`;
    d.canvas.style.transform = centered(0);
    await commitAdvance(dir, ni, resolveClip(e));
    advancing = 0;
  }

  function scheduleNext(): void {
    // Generation-guarded: a swipe/keys into the next clip inside the
    // window would otherwise let the stale timer advance AGAIN and
    // double-skip. Also yields to a manual seek/pause — either means
    // the user took the wheel.
    const g = clipGen;
    setTimeout((): void => {
      if (advancing || g !== clipGen) {return;}
      // 'paused' is overloaded: manual pause (hold the feed) AND the mode
      // natural end leaves — the lifecycle parks the clock at duration,
      // so end-of-clip must still advance while a mid-clip pause holds.
      const parkedAtEnd = dm.player.duration > 0 && dm.player.currentTimeValue >= dm.player.duration;
      if (dm.mode === 'playing' || (dm.mode === 'paused' && !parkedAtEnd)) {return;}
      go(1);
    }, NEXT_DELAY_MS);
  }

  // The lifecycle's own onPlaybackEnd only freezes the last frame — the
  // feed chains the auto-advance behind it.
  const prevEnd = dm.onPlaybackEnd;
  dm.onPlaybackEnd = (): void => { prevEnd?.(); scheduleNext(); };

  btnUp.addEventListener('click', (): Promise<void> => go(-1));
  btnDown.addEventListener('click', (): Promise<void> => go(1));
  btnPause.addEventListener('click', (): void => dm.togglePlayPause());
  btnSave.addEventListener('click', (): void => {
    const e = current();
    if (e) {dm.downloadCoolShotById(e.id);}
  });
  btnShare.addEventListener('click', (): void => {
    const e = current();
    if (!e?.filename) {return;}
    navigator.clipboard?.writeText(`${window.location.origin}/clips/${e.filename}`)
      .then((): void => { btnShare.textContent = '✓'; setTimeout((): void => { btnShare.textContent = '⤴'; }, 1200); return; })
      .catch((): void => { return; });
  });
  const toggleClear = (): void => {
    clearScreen = !clearScreen;
    root.classList.toggle('feed-clear', clearScreen);
  };
  btnClear.addEventListener('click', toggleClear);
  // Auto-routed (touch) exits keep the ?play opt-out so they don't loop
  // back into the feed; URL-routed exits drop to / normally.
  const exitTo = feedMode.auto ? '/?play' : '/';
  btnExit.addEventListener('click', (): void => { window.location.href = exitTo; });

  // Wheel deltas accumulate — a mouse notch arrives as one big event,
  // but precision trackpads stream many small ones that never reach a
  // per-event threshold (the feed would never move on a laptop pad).
  let wheelAcc = 0;
  window.addEventListener('wheel', (ev): void => {
    const now = performance.now();
    if (now < wheelLock) {wheelAcc = 0; return;}
    if (Math.sign(ev.deltaY) !== Math.sign(wheelAcc)) {wheelAcc = 0;}
    wheelAcc += ev.deltaY;
    if (Math.abs(wheelAcc) < 40) {return;}
    wheelLock = now + WHEEL_COOLDOWN;
    const dir = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    go(dir as 1 | -1);
  }, { passive: true });

  window.addEventListener('keydown', (ev): void => {
    switch (ev.code) {
      case 'ArrowDown': { go(1); break;
      }
      case 'ArrowUp': { go(-1); break;
      }
      case 'Space': { ev.preventDefault(); dm.togglePlayPause(); break;
      }
      case 'KeyC': { toggleClear(); break;
      }
      case 'Escape': { window.location.href = exitTo; break;
      }
          default: { break; }
}
  });

  // Tracked drag: the canvas follows the finger (translate only, no
  // transition), then commits past ~18% viewport or a flick and springs
  // back otherwise. touch-action:none is set while the feed runs so the
  // browser doesn't fight the gesture with pull-to-refresh.
  d.canvas.style.touchAction = 'none';
  window.addEventListener('touchstart', (ev): void => {
    if (entries.length === 0 || advancing) {return;}
    drag = {
      startY: ev.touches[0]!.clientY,
      samples: [{ t: performance.now(), y: ev.touches[0]!.clientY }],
      mounted: false, dir: 1, ni: index, ready: null,
    };
  }, { passive: true });
  window.addEventListener('touchmove', (ev): void => {
    if (!drag) {return;}
    const y = ev.touches[0]!.clientY;
    drag.samples.push({ t: performance.now(), y });
    if (drag.samples.length > 8) {drag.samples.shift();}
    const dy = drag.startY - y; // + = swiping up = next clip
    // Arm the neighbor on first meaningful travel — its placeholder card
    // tracks in with the finger; the real frame lands at commit. The
    // outgoing clip never pauses (one GL canvas = only it can animate).
    if (!drag.mounted && Math.abs(dy) > 12) {
      drag.mounted = true;
      drag.dir = dy >= 0 ? 1 : -1;
      drag.ni = wrapIdx(index + drag.dir);
      paintPlaceholder(entries[drag.ni]!);
      drag.ready = resolveClip(entries[drag.ni]!);
      trackPanes(Math.max(-window.innerHeight, Math.min(window.innerHeight, dy)), drag.dir);
    }
    if (drag.mounted) {
      const off = Math.max(-window.innerHeight, Math.min(window.innerHeight, dy));
      trackPanes(off, drag.dir);
    }
  }, { passive: true });
  window.addEventListener('touchend', (ev): void => {
    if (!drag) {return;}
    const d0 = drag;
    drag = null;
    const endY = ev.changedTouches[0]!.clientY;
    const dy = d0.startY - endY;
    // Flick velocity from the recent sample window — a short fast fling
    // commits even when the travel was small.
    const now = performance.now();
    const s0 = d0.samples.find((s): boolean => now - s.t <= 120) ?? d0.samples[0]!;
    const v = now > s0.t ? (s0.y - endY) / (now - s0.t) : 0; // px/ms, + = up
    const dir: 1 | -1 = (Math.abs(v) > 0.01 ? v : dy) >= 0 ? 1 : -1;
    if (!d0.mounted || advancing) {return;} // tap — nothing mounted
    const commit = Math.abs(dy) > window.innerHeight * SWIPE_COMMIT_RATIO || Math.abs(v) > FLICK_V_PX_MS;
    if (commit && dir === d0.dir) {
      advancing = dir;
      const {ni} = d0;
      const ready = d0.ready ?? resolveClip(entries[ni]!);
      (async (): Promise<void> => {
        await commitAdvance(dir, ni, ready);
        advancing = 0;
      })();
    } else {
      // Spring back — the outgoing clip never paused, so the restore is
      // pure CSS: both panes ease home and the poster drops.
      (async (): Promise<void> => {
        await slidePanes(d0.dir, false, SLIDE_MS);
        hidePoster();
      })();
    }
  }, { passive: true });

  // Progress bar + pause icon ride their own rAF — the demo UI's time
  // updates target its hidden transport bar, not the feed.
  const tick = (): void => {
    const dur = dm.player.duration;
    progressFill.style.transform = `scaleX(${dur > 0 ? Math.min(1, dm.player.currentTimeValue / dur) : 0})`;
    btnPause.textContent = dm.mode === 'playing' ? '❚❚' : '▶';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await dm.fetchCoolShotsFromServer();
  // Copy before shuffling — getCoolShots returns the manager's live
  // array and the panel's best-first order must survive feed playback.
  entries = [...dm.getCoolShots()];
  // Shuffle the queue — the index is lifetime-sorted, which makes every
  // feed session replay the same top-N run. One pass, one shuffle.
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  logger.info(`Clip feed: ${entries.length} clip(s)`);
  if (feedMode.startAt) {
    const at = entries.findIndex((e): boolean => e.filename === feedMode.startAt || e.id === feedMode.startAt);
    if (at === -1) {logger.warn(`Deep-link clip not on the server: ${feedMode.startAt}`);}
    else {index = at;}
  }
  play(index);
}
