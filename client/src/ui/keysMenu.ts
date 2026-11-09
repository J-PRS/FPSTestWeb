/**
 * Keybind editor — a single KEYBINDS button in the side menu opens a
 * centered popup listing every bindable action; click a key chip to
 * capture the next keypress (or mouse button) as the new binding.
 * Conflicts swap rather than orphan; Esc cancels a capture.
 */

import {
  BIND_DEFS, codeFor, codeLabel, rebind, resetAll, captureNextInput,
  isCapturing, cancelCapture,
  type BindAction,
} from '../core/keybinds.js';
import { isDevHost } from '../core/params.js';

export function buildKeysMenu(openBtn: HTMLElement, host: HTMLElement): { close(): void } {
  host.innerHTML = `
    <div class="keys-box">
      <div class="keys-head">
        <span class="keys-title">KEYBINDS</span>
        <button class="keys-close">✕</button>
      </div>
      <div class="keys-grid"></div>
      <div class="keys-grid keys-fixed"></div>
      <button class="keys-reset">RESET KEYS</button>
    </div>`;

  const grid = host.querySelector<HTMLElement>('.keys-grid')!;
  const chips = new Map<BindAction, HTMLElement>();

  function open(): void { host.classList.add('open'); }
  function close(): void {
    host.classList.remove('open');
    // A capture live at menu close would eat the next gameplay input.
    if (isCapturing()) {cancelCapture();}
  }

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
    row.append(label);
    const chip = document.createElement('button');
    chip.className = 'keys-chip';
    chip.textContent = codeLabel(codeFor(d.action));
    chip.addEventListener('click', (e): void => {
      e.stopPropagation();
      if (chip.classList.contains('capturing')) {return;}
      chip.classList.add('capturing');
      chip.textContent = '···';
      captureNextInput((code): void => {
        chip.classList.remove('capturing');
        if (code) {rebind(d.action, code);}
        refresh();
      });
    });
    chips.set(d.action, chip);
    row.append(chip);
    grid.append(row);
  }

  // Hardcoded keys — shown for completeness, not rebindable. Context-only
  // keys (demo F6/space, dev Alt+*) are deliberately absent.
  // Perf stats + pixel mode are dev tools - prod doesn't list them.
  const FIXED: [label: string, key: string][] = [
    ...(isDevHost() ? [['Perf stats', '`'] as [string, string], ['Pixel mode', 'F4'] as [string, string]] : []),
    ['Menu', 'ESC'],
  ];
  const fixedGrid = host.querySelector<HTMLElement>('.keys-fixed')!;
  for (const [label, key] of FIXED) {
    const row = document.createElement('div');
    row.className = 'keys-row';
    const span = document.createElement('span');
    span.className = 'keys-label';
    span.textContent = label;
    row.append(span);
    const chip = document.createElement('span');
    chip.className = 'keys-chip fixed';
    chip.textContent = key;
    row.append(chip);
    fixedGrid.append(row);
  }

  host.querySelector<HTMLElement>('.keys-close')!.addEventListener('click', (e): void => {
    e.stopPropagation();
    close();
  });
  // Click on the dim backdrop closes; clicks inside the box don't reach it
  // (overlay's own click handler only fires on e.target === overlay anyway).
  host.addEventListener('click', (e): void => {
    if (e.target === host) {close();}
  });
  // Esc closes the popup — but not while a capture is live (Esc there means
  // "cancel the rebind" and is already consumed by the capture listener).
  document.addEventListener('keydown', (e): void => {
    if (e.code === 'Escape' && host.classList.contains('open') && !isCapturing()) {
      e.stopImmediatePropagation();
      close();
    }
  });

  host.querySelector<HTMLElement>('.keys-reset')!.addEventListener('click', (e): void => {
    e.stopPropagation();
    resetAll();
    refresh();
  });

  openBtn.addEventListener('click', (e): void => {
    e.stopPropagation();
    open();
  });
  return { close };
}
