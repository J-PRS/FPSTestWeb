import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import { SKILL_ORDER, Player, type SkillId } from '../entities/Player.js';
import type { HUD } from './hud.js';
import { WEAPON_CONFIGS } from '../projectiles/index.js';
import { audio } from '../core/audio.js';

export interface OverlayInputDeps {
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
  demoManager: () => DemoManager | null;
  hud: () => HUD;
  logger: ChildLogger;
  isGameStarted: () => boolean;
  player: () => Player;
}

// Overlay / pointer-lock / global key handling: ESC menu flow (Krunker-style —
// any lock exit opens the menu), scoreboard Tab, demo playback arrow keys,
// F4 pixel toggle, F6 demo UI, Space pause.
export function wireOverlayInput(deps: OverlayInputDeps) {
  const { overlay, rendererCanvas, logger } = deps;

  // ---- Loadout bar (bottom-center of the ESC menu) ----
  // Each of the 4 slots is a dropdown — click a slot, pick the weapon.
  // Belt (F) is a pair of chips; skill (Q) toggles on click.
  const loadoutBar = document.getElementById('loadout-bar');
  const slotSelects: HTMLSelectElement[] = [];
  let beltSelRef: HTMLSelectElement | null = null;
  let skillSelRef: HTMLSelectElement | null = null;
  if (loadoutBar) {
    for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
      const row = document.createElement('div');
      row.className = 'lo-row';
      const label = document.createElement('span');
      label.className = 'lo-label';
      label.textContent = `SLOT ${i + 1}`;
      row.appendChild(label);
      const sel = document.createElement('select');
      sel.className = 'lo-chip lo-select';
      WEAPON_CONFIGS.forEach((cfg, wid) => {
        const opt = document.createElement('option');
        opt.value = String(wid);
        opt.textContent = cfg.displayName;
        sel.appendChild(opt);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        deps.player().setLoadoutSlot(i, Number(sel.value));
        refreshLoadout();
      });
      row.appendChild(sel);
      slotSelects.push(sel);
      loadoutBar.appendChild(row);
    }

    const beltRow = document.createElement('div');
    beltRow.className = 'lo-row';
    beltRow.innerHTML = `<span class="lo-label">BELT (C)</span>`;
    const beltSel = document.createElement('select');
    beltSel.className = 'lo-chip lo-select';
    for (const item of ['disc', 'grenade'] as const) {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item === 'disc' ? 'Disc' : 'Grenade';
      beltSel.appendChild(opt);
    }
    beltSel.addEventListener('click', (e) => e.stopPropagation());
    beltSel.addEventListener('change', (e) => {
      e.stopPropagation();
      deps.player().setBeltItem(beltSel.value as 'disc' | 'grenade');
    });
    beltRow.appendChild(beltSel);
    beltSelRef = beltSel;

    const skillSel = document.createElement('select');
    skillSel.className = 'lo-chip lo-select';
    for (const s of SKILL_ORDER) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s[0].toUpperCase() + s.slice(1);
      skillSel.appendChild(opt);
    }
    skillSel.addEventListener('click', (e) => e.stopPropagation());
    skillSel.addEventListener('change', (e) => {
      e.stopPropagation();
      deps.player().setSkill(skillSel.value as SkillId);
    });
    const skillWrap = document.createElement('div');
    skillWrap.className = 'lo-row';
    skillWrap.innerHTML = `<span class="lo-label">SKILL (Q)</span>`;
    skillWrap.appendChild(skillSel);
    skillSelRef = skillSel;
    loadoutBar.appendChild(beltRow);
    loadoutBar.appendChild(skillWrap);
  }
  function refreshLoadout(): void {
    const player = deps.player();
    slotSelects.forEach((sel, i) => {
      sel.value = String(player.loadout[i]);
      sel.classList.toggle('active', i === player.weaponIndex);
    });
    if (beltSelRef) beltSelRef.value = player.beltItem;
    if (skillSelRef) skillSelRef.value = player.skill;
  }

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
      const dm = deps.demoManager();
      dm?.onCoolShotsChanged?.(dm.getCoolShots());
      dm?.fetchCoolShotsFromServer();
    }
  });

  // Demo playback keys (arrow keys). Returns true if the key was consumed.
  function handleDemoKey(e: KeyboardEvent): boolean {
    const dm = deps.demoManager();
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
    const dm = deps.demoManager();
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
    if (e.code === 'Tab') {
      e.preventDefault();
      deps.hud().setScoreboardVisible(true);
      return;
    }
    const dm = deps.demoManager();
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
      deps.hud().setScoreboardVisible(false);
    }
    if (e.code === 'F6') {
      deps.demoManager()?.toggleUI();
    }
    if (e.code === 'Space' && deps.demoManager()?.isLoadedForPlayback) {
      e.preventDefault();
      deps.demoManager()!.togglePlayPause();
      return;
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    const dm = deps.demoManager();
    if (dm?.isPlaying) { dm.stopPlayback(); return; }
    requestLock();
  });
  rendererCanvas.addEventListener('click', () => {
    if (deps.demoManager()?.isPlaying) return;
    if (document.pointerLockElement !== rendererCanvas) requestLock();
  });

  return { requestLock };
}
