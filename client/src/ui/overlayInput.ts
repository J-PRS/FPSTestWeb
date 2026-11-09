import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import type { HUD } from './hud.js';
import { audio } from '../core/audio.js';
import { buildKeysMenu } from './keysMenu.js';
import { isCapturing, matchCode } from '../core/keybinds.js';
import { wireLoadoutBar } from './loadoutMenu.js';
import { wireLabButton } from '../lab/labView.js';

export interface OverlayInputDeps {
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
  lazyDemoManager: () => DemoManager | null;
  lazyHud: () => HUD;
  logger: ChildLogger;
  isGameStarted: () => boolean;
  lazyPlayer: () => Player;
  /** Online only - class picks get announced so the server banks the
   *  same tier swap for respawn. Absent offline. */
  lazyNetworkManager?: () => { sendClassUpdate(armorClass: string): void; sendPerkUpdate(perk: string): void } | null;
}

// While a demo plays, gameplay keys belong to the player — only the
// transport controls (Escape/F6/arrows) still reach the overlay.
function demoOwnsKey(dm: DemoManager | null, code: string): boolean {
  return Boolean(dm?.isPlaying) && code !== 'Escape' && code !== 'F6' &&
    code !== 'ArrowUp' && code !== 'ArrowDown' && code !== 'ArrowLeft' && code !== 'ArrowRight';
}

// Overlay / pointer-lock / global key handling: ESC menu flow (Krunker-style —
// any lock exit opens the menu), scoreboard Tab, demo playback arrow keys,
// F4 pixel toggle, F6 demo UI, Space pause.
export function wireOverlayInput(deps: OverlayInputDeps): { requestLock: () => void; } {
  const { overlay, rendererCanvas, logger } = deps;

  // Loadout bar lives in its own module — it builds the chip/dropup DOM and
  // owns the refreshLoadout funnel the overlay opens through.
  const loadout = wireLoadoutBar(deps);
  const {refreshLoadout} = loadout;

  const keysOpen = document.getElementById('keys-open');
  const keysModal = document.getElementById('keys-modal');
  const keysMenu = keysOpen && keysModal ? buildKeysMenu(keysOpen, keysModal) : null;

  // Section expanders: a label folds its rows until the next label.
  // PROFILE (name/play) stays open - the core row never collapses.
  document.querySelectorAll('#menu-side .section-label').forEach((label): void => {
    if (label.textContent === 'PROFILE') {return;}
    label.classList.add('expandable');
    label.addEventListener('click', (): void => {
      const off = label.classList.toggle('collapsed');
      let el = label.nextElementSibling;
      while (el && !el.classList.contains('section-label')) {
        (el as HTMLElement).style.display = off ? 'none' : '';
        el = el.nextElementSibling;
      }
    });
  });
  wireLabButton();

  // Single source of truth for menu visibility — sets overlay display AND
  // the body class that hides the HUD layer (inline display:block left by
  // hud.show() would beat a plain CSS selector, so the rule uses !important).
  function setOverlay(open: boolean): void {
    overlay.style.display = open ? 'flex' : 'none';
    document.body.classList.toggle('menu-open', open);
    audio.setDucked(open);
    if (open) {refreshLoadout();}
    else {
      // Nothing may strand open over a resume — dropups, the keybind
      // popup, or a live "press any key" capture all reset here.
      loadout.closeDrops();
      keysMenu?.close();
    }
  }

  function requestLock(): void {
    // AudioContext unlocks on user gesture — the click that enters pointer
    // lock is exactly that gesture.
    audio.unlock();
    // Raw mouse input first — unadjustedMovement kills the OS accel curve
    // so cm/360 means the same thing on every box (Chrome ≥88; FF/Safari
    // ignore or reject the option). Falls back to the plain call.
    const warnCooldown = (): void => {
      logger.info('Pointer lock on cooldown — browser requires a brief delay after exiting lock. Click again to re-enter.');
    };
    const lock = (raw: boolean): void => {
      let p: Promise<void> | undefined;
      try { p = rendererCanvas.requestPointerLock(raw ? ({ unadjustedMovement: true } as Parameters<HTMLElement['requestPointerLock']>[0]) : undefined) as Promise<void> | undefined; }
      catch { if (raw) {lock(false);} else {warnCooldown();} return; }
      p?.catch?.((): void => { if (raw) {lock(false);} else {warnCooldown();} });
    };
    lock(true);
  }

  document.addEventListener('pointerlockchange', (): void => {
    logger.debug(`Pointer lock changed: locked=${document.pointerLockElement === rendererCanvas}`);
    if (document.pointerLockElement === rendererCanvas) {
      setOverlay(false);
    } else if (deps.isGameStarted()) {
      // Browsers reserve ESC for exiting pointer lock — its keydown never reaches
      // the page while locked. So treat any lock exit (ESC, alt-tab, browser UI)
      // as "open the menu", same as Krunker.
      setOverlay(true);
      const dm = deps.lazyDemoManager();
      dm?.onCoolShotsChanged?.(dm.getCoolShots());
      dm?.fetchCoolShotsFromServer();
    }
  });

  // Demo playback keys (arrow keys). Returns true if the key was consumed.
  function handleDemoKey(e: KeyboardEvent): boolean {
    const dm = deps.lazyDemoManager();
    if (!dm?.isPlaying) {return false;}
    const action = ({
      ArrowUp: (): void => dm.togglePlayPause(),
      ArrowDown: (): void => dm.restart(),
      ArrowLeft: (): void => dm.seekBy(-2),
      ArrowRight: (): void => dm.seekBy(2),
    } as Record<string, () => void>)[e.code];
    if (!action) {return false;}
    e.preventDefault();
    action();
    return true;
  }

  function handleEscapeKey(): void {
    const dm = deps.lazyDemoManager();
    if (dm?.isPlaying) {
      dm.stopPlayback();
      return;
    }
    if (document.pointerLockElement === rendererCanvas) {
      document.exitPointerLock();
      // pointerlockchange handler opens the overlay
    } else if (overlay.style.display === 'flex') {
      setOverlay(false);
      logger.debug('Requesting pointer lock...');
      requestLock();
    } else {
      setOverlay(true);
    }
  }

  document.addEventListener('keydown', (e): void => {
    // A keybind capture owns the next keystroke — it must not leak into
    // menu/demo handling (its listener already stops propagation, this is
    // belt-and-braces for ordering across modules)
    if (isCapturing()) {return;}
    if (matchCode('scoreboard', e.code)) {
      e.preventDefault();
      deps.lazyHud().setScoreboardVisible(true);
      return;
    }
    if (matchCode('commandMap', e.code) && deps.isGameStarted()) {
      deps.lazyHud().toggleCommandMap();
      return;
    }
    const dm = deps.lazyDemoManager();
    if (demoOwnsKey(dm, e.code)) {return;}
    if (handleDemoKey(e)) {return;}
    if (e.code === 'Escape' && deps.isGameStarted()) {handleEscapeKey();}
    if (e.code === 'F4') {
      const pixelToggleBtn = document.querySelector('#pixel-toggle')! as HTMLButtonElement;
      pixelToggleBtn.click();
    }
  });

  document.addEventListener('keyup', (e): void => {
    if (matchCode('scoreboard', e.code)) {
      e.preventDefault();
      deps.lazyHud().setScoreboardVisible(false);
    }
    if (e.code === 'F6') {
      deps.lazyDemoManager()?.toggleUI();
    }
    if (e.code === 'Space' && deps.lazyDemoManager()?.isLoadedForPlayback) {
      e.preventDefault();
      deps.lazyDemoManager()!.togglePlayPause();
      return;
    }
  });

  overlay.addEventListener('click', (e): void => {
    if (e.target !== overlay) {return;}
    const dm = deps.lazyDemoManager();
    if (dm?.isPlaying) { dm.stopPlayback(); return; }
    requestLock();
  });
  rendererCanvas.addEventListener('click', (): void => {
    if (deps.lazyDemoManager()?.isPlaying) {return;}
    if (document.pointerLockElement !== rendererCanvas) {requestLock();}
  });

  return { requestLock };
}
