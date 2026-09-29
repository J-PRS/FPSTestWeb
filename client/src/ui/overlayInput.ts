import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import { Player } from '../entities/Player.js';
import type { HUD } from './hud.js';
import { audio } from '../core/audio.js';
import { buildKeysMenu } from './keysMenu.js';
import { isCapturing } from '../core/keybinds.js';
import { wireLoadoutBar } from './loadoutMenu.js';

export interface OverlayInputDeps {
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
  lazyDemoManager: () => DemoManager | null;
  lazyHud: () => HUD;
  logger: ChildLogger;
  isGameStarted: () => boolean;
  lazyPlayer: () => Player;
  /** Online only — class picks get announced so the server banks the
   *  same tier swap for respawn. Absent offline. */
  lazyNetworkManager?: () => { sendClassUpdate(armorClass: string): void; sendPerkUpdate(perk: string): void } | null;
}

// Overlay / pointer-lock / global key handling: ESC menu flow (Krunker-style —
// any lock exit opens the menu), scoreboard Tab, demo playback arrow keys,
// F4 pixel toggle, F6 demo UI, Space pause.
export function wireOverlayInput(deps: OverlayInputDeps) {
  const { overlay, rendererCanvas, logger } = deps;

  // Loadout bar lives in its own module — it builds the chip/dropup DOM and
  // owns the refreshLoadout funnel the overlay opens through.
  const loadout = wireLoadoutBar(deps);
  const refreshLoadout = loadout.refreshLoadout;

  const keysOpen = document.getElementById('keys-open');
  const keysModal = document.getElementById('keys-modal');
  if (keysOpen && keysModal) buildKeysMenu(keysOpen, keysModal);

  // Single source of truth for menu visibility — sets overlay display AND
  // the body class that hides the HUD layer (inline display:block left by
  // hud.show() would beat a plain CSS selector, so the rule uses !important).
  function setOverlay(open: boolean): void {
    overlay.style.display = open ? 'flex' : 'none';
    document.body.classList.toggle('menu-open', open);
    if (open) refreshLoadout();
  }

  function requestLock(): void {
    // AudioContext unlocks on user gesture — the click that enters pointer
    // lock is exactly that gesture.
    audio.unlock();
    const p = rendererCanvas.requestPointerLock();
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => {
        logger.info('Pointer lock on cooldown — browser requires a brief delay after exiting lock. Click again to re-enter.');
      });
    }
  }

  document.addEventListener('pointerlockchange', () => {
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
    if (!dm?.isPlaying) return false;
    const action = ({
      ArrowUp: () => dm.togglePlayPause(),
      ArrowDown: () => dm.restart(),
      ArrowLeft: () => dm.seekBy(-2),
      ArrowRight: () => dm.seekBy(2),
    } as Record<string, () => void>)[e.code];
    if (!action) return false;
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

  document.addEventListener('keydown', (e) => {
    // A keybind capture owns the next keystroke — it must not leak into
    // menu/demo handling (its listener already stops propagation, this is
    // belt-and-braces for ordering across modules)
    if (isCapturing()) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      deps.lazyHud().setScoreboardVisible(true);
      return;
    }
    const dm = deps.lazyDemoManager();
    if (dm?.isPlaying && e.code !== 'Escape' && e.code !== 'F6' &&
        e.code !== 'ArrowUp' && e.code !== 'ArrowDown' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') {
      return;
    }
    if (handleDemoKey(e)) return;
    if (e.code === 'Escape' && deps.isGameStarted()) handleEscapeKey();
    if (e.code === 'F4') {
      const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
      pixelToggleBtn.click();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') {
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

  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    const dm = deps.lazyDemoManager();
    if (dm?.isPlaying) { dm.stopPlayback(); return; }
    requestLock();
  });
  rendererCanvas.addEventListener('click', () => {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (document.pointerLockElement !== rendererCanvas) requestLock();
  });

  return { requestLock };
}
