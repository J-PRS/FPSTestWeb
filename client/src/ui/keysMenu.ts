/**
 * ESC-menu keybind editor — one row per bindable action; click the key chip
 * to capture the next keypress (or mouse button) as the new binding. Conflicts
 * swap rather than orphan; Esc cancels a capture. Lives in #menu-side.
 */

import {
  BIND_DEFS, codeFor, codeLabel, rebind, resetAll, captureNextInput,
  type BindAction,
} from '../core/keybinds.js';

export function buildKeysMenu(container: HTMLElement): void {
  const list = document.createElement('div');
  list.className = 'keys-rows';
  container.appendChild(list);

  const chips = new Map<BindAction, HTMLElement>();

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
    list.appendChild(row);
  }

  const reset = document.createElement('button');
  reset.className = 'keys-reset';
  reset.textContent = 'RESET KEYS';
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    resetAll();
    refresh();
  });
  container.appendChild(reset);
}
