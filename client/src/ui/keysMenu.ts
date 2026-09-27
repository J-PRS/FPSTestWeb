/**
 * Keybind editor — a single KEYBINDS button in the side menu opens a
 * centered popup listing every bindable action; click a key chip to
 * capture the next keypress (or mouse button) as the new binding.
 * Conflicts swap rather than orphan; Esc cancels a capture.
 */

import {
  BIND_DEFS, codeFor, codeLabel, rebind, resetAll, captureNextInput,
  isCapturing,
  type BindAction,
} from '../core/keybinds.js';

export function buildKeysMenu(openBtn: HTMLElement, host: HTMLElement): void {
  host.innerHTML = `
    <div class="keys-box">
      <div class="keys-head">
        <span class="keys-title">KEYBINDS</span>
        <button class="keys-close">✕</button>
      </div>
      <div class="keys-grid"></div>
      <button class="keys-reset">RESET KEYS</button>
    </div>`;

  const grid = host.querySelector<HTMLElement>('.keys-grid')!;
  const chips = new Map<BindAction, HTMLElement>();

  function open(): void { host.classList.add('open'); }
  function close(): void { host.classList.remove('open'); }

  function refresh(): void {
    for (const d of BIND_DEFS) {
      const chip = chips.get(d.action);
      if (chip && !chip.classList.contains('capturing')) {
        chip.textContent = codeLabel(codeFor(d.action));
      }
    }
  }

  for (const d of BIND_DEFS) {
    const row = document.createElement('div');
    row.className = 'keys-row';
    const label = document.createElement('span');
    label.className = 'keys-label';
    label.textContent = d.label;
    row.appendChild(label);
    const chip = document.createElement('button');
    chip.className = 'keys-chip';
    chip.textContent = codeLabel(codeFor(d.action));
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (chip.classList.contains('capturing')) return;
      chip.classList.add('capturing');
      chip.textContent = '···';
      captureNextInput((code) => {
        chip.classList.remove('capturing');
        if (code) rebind(d.action, code);
        refresh();
      });
    });
    chips.set(d.action, chip);
    row.appendChild(chip);
    grid.appendChild(row);
  }

  host.querySelector<HTMLElement>('.keys-close')!.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  // Click on the dim backdrop closes; clicks inside the box don't reach it
  // (overlay's own click handler only fires on e.target === overlay anyway).
  host.addEventListener('click', (e) => {
    if (e.target === host) close();
  });
  // Esc closes the popup — but not while a capture is live (Esc there means
  // "cancel the rebind" and is already consumed by the capture listener).
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && host.classList.contains('open') && !isCapturing()) {
      e.stopImmediatePropagation();
      close();
    }
  });

  host.querySelector<HTMLElement>('.keys-reset')!.addEventListener('click', (e) => {
    e.stopPropagation();
    resetAll();
    refresh();
  });

  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });
}
