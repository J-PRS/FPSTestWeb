import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import { SKILL_ORDER, Player, type SkillId, BELT_ITEMS, type BeltItem } from '../entities/Player.js';
import { PERKS, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import type { HUD } from './hud.js';
import { SLOT_DEFS } from '../weapons.js';
import { audio } from '../core/audio.js';
import { buildKeysMenu } from './keysMenu.js';
import { isCapturing, codeFor, codeLabel } from '../core/keybinds.js';

export interface OverlayInputDeps {
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
  lazyDemoManager: () => DemoManager | null;
  lazyHud: () => HUD;
  logger: ChildLogger;
  isGameStarted: () => boolean;
  lazyPlayer: () => Player;
}

// Overlay / pointer-lock / global key handling: ESC menu flow (Krunker-style —
// any lock exit opens the menu), scoreboard Tab, demo playback arrow keys,
// F4 pixel toggle, F6 demo UI, Space pause.
export function wireOverlayInput(deps: OverlayInputDeps) {
  const { overlay, rendererCanvas, logger } = deps;

  // ---- Loadout bar (bottom-center of the ESC menu) ----
  // Custom dropups, not <select> — a native popup is OS chrome and breaks
  // the game-menu illusion. Chip face + styled option list opening upward.
  const loadoutBar = document.getElementById('loadout-bar');
  interface Drop { el: HTMLElement; setValue(v: string): void; }
  const slotDrops: Drop[] = [];
  let beltDrop: Drop | null = null;
  let skillDrop: Drop | null = null;
  let perkDrop: Drop | null = null;
  let sidearmDrop: Drop | null = null;
  let packDrop: Drop | null = null;
  let beltLabel: HTMLElement | null = null;
  let skillLabel: HTMLElement | null = null;
  let sidearmLabel: HTMLElement | null = null;
  let packLabel: HTMLElement | null = null;
  let openDrop: HTMLElement | null = null;

  // Chip width is measured, not hardcoded — canvas-measure the widest
  // option (uppercased, same font as .lo-opt) + padding + caret so no
  // label ever overflows and no chip is wider than it needs to be.
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  function dropWidth(options: { label: string }[]): number {
    // Same font as .lo-opt: 600 0.66rem in the body family, uppercased
    measureCtx.font = `600 ${0.66 * 16}px ${getComputedStyle(document.body).fontFamily}`;
    let w = 0;
    for (const o of options) w = Math.max(w, measureCtx.measureText(o.label.toUpperCase()).width);
    return Math.ceil(w) + 11 * 2 + 8 + 12; // padding + gap + caret
  }

  const BELT_LABELS: Record<BeltItem, string> = {
    disc: 'Disc', grenade: 'Grenade', cluster: 'Cluster Bomb',
    javelin: 'Javelin', sticky: 'Sticky Bomb', impact: 'Impact Grenade',
    remoterailgun: 'Remote Railgun',
  };

  function mkDrop(
    options: { v: string; label: string }[],
    onPick: (v: string) => void,
  ): Drop {
    const el = document.createElement('div');
    el.className = 'lo-chip lo-drop';
    el.style.minWidth = `${dropWidth(options)}px`;
    const face = document.createElement('span');
    el.appendChild(face);
    const caret = document.createElement('span');
    caret.className = 'lo-caret';
    caret.textContent = '▴';
    el.appendChild(caret);
    const list = document.createElement('div');
    list.className = 'lo-list';
    for (const o of options) {
      const it = document.createElement('div');
      it.className = 'lo-opt';
      it.textContent = o.label;
      it.dataset.v = o.v;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(o.v);
        el.classList.remove('open');
        openDrop = null;
        refreshLoadout();
      });
      list.appendChild(it);
    }
    el.appendChild(list);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = el.classList.contains('open');
      openDrop?.classList.remove('open');
      el.classList.toggle('open', !was);
      openDrop = was ? null : el;
    });
    return {
      el,
      setValue(v) {
        face.textContent = options.find((o) => o.v === v)?.label ?? v;
        list.querySelectorAll<HTMLElement>('.lo-opt').forEach((o) =>
          o.classList.toggle('sel', o.dataset.v === v));
      },
    };
  }

  // Clicking the bar's dead space closes any open dropup
  loadoutBar?.addEventListener('click', () => {
    openDrop?.classList.remove('open');
    openDrop = null;
  });

  const keysOpen = document.getElementById('keys-open');
  const keysModal = document.getElementById('keys-modal');
  if (keysOpen && keysModal) buildKeysMenu(keysOpen, keysModal);


  if (loadoutBar) {
    // Sidearms are chosen in their own row — a primary slot offering them
    // would let a loadout double-carry the hold-out tier.
    const weaponOpts = SLOT_DEFS
      .map((def, wid) => ({ v: String(wid), label: def.config.displayName, sidearm: !!def.sidearm }))
      .filter((o) => !o.sidearm);
    for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
      const row = document.createElement('div');
      row.className = 'lo-row';
      const label = document.createElement('span');
      label.className = 'lo-label';
      label.textContent = `SLOT ${i + 1}`;
      row.appendChild(label);
      const drop = mkDrop(weaponOpts, (v) => deps.lazyPlayer().setLoadoutSlot(i, Number(v)));
      row.appendChild(drop.el);
      slotDrops.push(drop);
      loadoutBar.appendChild(row);
    }

    const beltRow = document.createElement('div');
    beltRow.className = 'lo-row';
    beltLabel = document.createElement('span');
    beltLabel.className = 'lo-label';
    beltRow.appendChild(beltLabel);
    beltDrop = mkDrop(
      BELT_ITEMS.map((b) => ({ v: b, label: BELT_LABELS[b] })),
      (v) => deps.lazyPlayer().setBeltItem(v as BeltItem),
    );
    beltRow.appendChild(beltDrop.el);
    loadoutBar.appendChild(beltRow);

    const sidearmRow = document.createElement('div');
    sidearmRow.className = 'lo-row';
    sidearmLabel = document.createElement('span');
    sidearmLabel.className = 'lo-label';
    sidearmRow.appendChild(sidearmLabel);
    sidearmDrop = mkDrop(
      [{ v: 'pistol', label: 'Pistol' }, { v: 'revolver', label: 'Revolver' }, { v: 'shotgun', label: 'Shotgun' }],
      (v) => deps.lazyPlayer().setSidearm(v as 'pistol' | 'revolver' | 'shotgun'),
    );
    sidearmRow.appendChild(sidearmDrop.el);
    loadoutBar.appendChild(sidearmRow);

    const packRow = document.createElement('div');
    packRow.className = 'lo-row';
    packLabel = document.createElement('span');
    packLabel.className = 'lo-label';
    packRow.appendChild(packLabel);
    packDrop = mkDrop(
      [{ v: 'turret', label: 'Sentry' }, { v: 'mine', label: 'Mine' }, { v: 'station', label: 'Pad' }, { v: 'drone', label: 'Drone' }],
      (v) => deps.lazyPlayer().setPackItem(v as 'turret' | 'mine' | 'station' | 'drone'),
    );
    packRow.appendChild(packDrop.el);
    loadoutBar.appendChild(packRow);

    const skillRow = document.createElement('div');
    skillRow.className = 'lo-row';
    skillLabel = document.createElement('span');
    skillLabel.className = 'lo-label';
    skillRow.appendChild(skillLabel);
    skillDrop = mkDrop(
      SKILL_ORDER.map((s) => ({ v: s, label: s[0].toUpperCase() + s.slice(1) })),
      (v) => deps.lazyPlayer().setSkill(v as SkillId),
    );
    skillRow.appendChild(skillDrop.el);
    loadoutBar.appendChild(skillRow);

    const perkRow = document.createElement('div');
    perkRow.className = 'lo-row';
    const perkLabel = document.createElement('span');
    perkLabel.className = 'lo-label';
    perkLabel.textContent = 'PERK';
    perkRow.appendChild(perkLabel);
    perkDrop = mkDrop(
      PERK_ORDER.map((p) => ({ v: p, label: PERKS[p].name })),
      (v) => deps.lazyPlayer().setPerk(v as PerkId),
    );
    perkRow.appendChild(perkDrop.el);
    loadoutBar.appendChild(perkRow);
  }

  function refreshLoadout(): void {
    const player = deps.lazyPlayer();
    slotDrops.forEach((d, i) => d.setValue(String(player.loadout[i])));
    beltDrop?.setValue(player.beltItem);
    skillDrop?.setValue(player.skill);
    perkDrop?.setValue(player.perk);
    sidearmDrop?.setValue(player.sidearm);
    packDrop?.setValue(player.packItem);
    if (beltLabel) beltLabel.textContent = `BELT (${codeLabel(codeFor('belt'))})`;
    if (skillLabel) skillLabel.textContent = `SKILL (${codeLabel(codeFor('skill'))})`;
    if (sidearmLabel) sidearmLabel.textContent = `SIDEARM (${codeLabel(codeFor('sidearm'))})`;
    if (packLabel) packLabel.textContent = `PACK (${codeLabel(codeFor('deploy'))})`;
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
