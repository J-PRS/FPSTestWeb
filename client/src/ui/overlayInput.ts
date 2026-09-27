import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import { SKILL_ORDER } from '../entities/Player.js';
import type { HUD } from './hud.js';
import { WEAPON_CONFIGS } from '../projectiles/index.js';

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
  // Weapon chips are generated from WEAPON_CONFIGS so a new weapon just
  // appears. Belt items (C/F) are display-only today — they become real
  // choices once the loadout model exists. Skill slot is a stub.
  const loadoutBar = document.getElementById('loadout-bar');
  const weaponChips: HTMLElement[] = [];
  let skillChipRef: HTMLElement | null = null;
  if (loadoutBar) {
    const row = document.createElement('div');
    row.className = 'lo-row';
    const label = document.createElement('span');
    label.className = 'lo-label';
    label.textContent = 'WEAPON';
    row.appendChild(label);
    WEAPON_CONFIGS.forEach((cfg, i) => {
      const chip = document.createElement('button');
      chip.className = 'lo-chip';
      chip.innerHTML = `<span class="k">${i + 1}</span>${cfg.displayName}`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation(); // don't fall through to overlay-resume click
        const player = deps.player();
        if (player.weaponIndex !== i) {
          player.weaponIndex = i;
          player.onWeaponSwitch?.(i);
        }
        refreshLoadout();
      });
      row.appendChild(chip);
      weaponChips.push(chip);
    });
    loadoutBar.appendChild(row);

    const beltRow = document.createElement('div');
    beltRow.className = 'lo-row';
    beltRow.innerHTML = `<span class="lo-label">BELT</span>`;
    for (const [key, name] of [['C', 'Disc'], ['F', 'Grenade']] as const) {
      const chip = document.createElement('span');
      chip.className = 'lo-chip stub';
      chip.innerHTML = `<span class="k">${key}</span>${name}`;
      beltRow.appendChild(chip);
    }
    // Skill slot — one skill equipped at a time, click to toggle
    const skillChip = document.createElement('button');
    skillChip.className = 'lo-chip';
    skillChip.addEventListener('click', (e) => {
      e.stopPropagation();
      const player = deps.player();
      const next = SKILL_ORDER[(SKILL_ORDER.indexOf(player.skill) + 1) % SKILL_ORDER.length];
      player.setSkill(next);
      refreshLoadout();
    });
    beltRow.appendChild(skillChip);
    loadoutBar.appendChild(beltRow);
    skillChipRef = skillChip;
  }
  function refreshLoadout(): void {
    const player = deps.player();
    const idx = player.weaponIndex;
    weaponChips.forEach((c, i) => c.classList.toggle('active', i === idx));
    if (skillChipRef) {
      skillChipRef.innerHTML = `<span class="k">Q</span>${player.skill.toUpperCase()}`;
      skillChipRef.classList.add('active');
    }
  }

  function requestLock(): void {
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
      overlay.style.display = 'none';
    } else if (deps.isGameStarted()) {
      // Browsers reserve ESC for exiting pointer lock — its keydown never reaches
      // the page while locked. So treat any lock exit (ESC, alt-tab, browser UI)
      // as "open the menu", same as Krunker.
      overlay.style.display = 'flex';
      refreshLoadout();
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
      overlay.style.display = 'none';
      logger.debug('Requesting pointer lock...');
      requestLock();
    } else {
      overlay.style.display = 'flex';
      refreshLoadout();
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
