/**
 * Rebindable key map — the single source of truth for gameplay binds.
 * Actions are semantic (what the key DOES), stored as KeyboardEvent.code
 * or 'Mouse0'..'Mouse4' for buttons. Persisted in settings as a compact
 * "action=code,action=code" string; unknown/missing actions fall back to
 * defaults so a stale save never breaks input.
 */

import { settings } from './settings.js';

export type BindAction =
  | 'fire' | 'jet'
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'ski' | 'belt' | 'melee' | 'camera' | 'skill' | 'spectate' | 'respawn' | 'throwFlag' | 'dieSpectate'
  | 'sidearm'
  | 'deploy'
  | 'slot0' | 'slot1' | 'slot2' | 'slot3'
  | 'scoreboard' | 'commandMap' | 'chatAll' | 'chatTeam' | 'vgs';

export interface BindDef { action: BindAction; label: string; def: string }

export const BIND_DEFS: BindDef[] = [
  { action: 'fire',    label: 'Fire',          def: 'Mouse0' },
  { action: 'jet',     label: 'Jet',           def: 'Mouse2' },
  { action: 'forward', label: 'Move forward',  def: 'KeyW' },
  { action: 'back',    label: 'Move back',     def: 'KeyS' },
  { action: 'left',    label: 'Strafe left',   def: 'KeyA' },
  { action: 'right',   label: 'Strafe right',  def: 'KeyD' },
  { action: 'jump',    label: 'Jump / hop',    def: 'ShiftLeft' },
  { action: 'ski',     label: 'Ski',           def: 'Space' },
  { action: 'belt',    label: 'Belt item',     def: 'KeyC' },
  { action: 'melee',   label: 'Melee',         def: 'KeyE' },
  { action: 'camera',  label: 'Third person',  def: 'KeyZ' },
  { action: 'skill',   label: 'Skill',         def: 'KeyQ' },
  // VGS owns V (Tribes convention) — spectate lives on P.
  { action: 'spectate', label: 'Spectator fly', def: 'KeyP' },
  { action: 'sidearm',     label: 'Sidearm (hold)',   def: 'KeyF' },
  { action: 'deploy',      label: 'Deploy pack item', def: 'KeyX' },
  { action: 'respawn',     label: 'Respawn',          def: 'KeyK' },
  { action: 'dieSpectate', label: 'Die + spectate',   def: 'KeyL' },
  { action: 'throwFlag',   label: 'Throw flag',       def: 'KeyG' },
  { action: 'slot0',   label: 'Weapon slot 1', def: 'Digit1' },
  { action: 'slot1',   label: 'Weapon slot 2', def: 'Digit2' },
  { action: 'slot2',   label: 'Weapon slot 3', def: 'Digit3' },
  { action: 'slot3',   label: 'Weapon slot 4', def: 'Digit4' },
  { action: 'scoreboard', label: 'Scoreboard (hold)', def: 'Tab' },
  { action: 'commandMap', label: 'Command map',       def: 'KeyM' },
  { action: 'chatAll',    label: 'Chat all',          def: 'KeyT' },
  { action: 'chatTeam',   label: 'Chat team',         def: 'KeyY' },
  { action: 'vgs',        label: 'VGS menu',          def: 'KeyV' },
];

const DEFAULTS = Object.fromEntries(BIND_DEFS.map((d): [BindAction, string] => [d.action, d.def])) as Record<BindAction, string>;

function parseSaved(raw: string): Partial<Record<BindAction, string>> {
  const out: Partial<Record<BindAction, string>> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=');
    // spectate=V predates VGS taking V — drop the stale save so it falls
    // through to the new default instead of colliding with the menu.
    if (k && v && k in DEFAULTS && !(k === 'spectate' && v === 'KeyV')) {out[k as BindAction] = v;}
  }
  return out;
}

const binds: Record<BindAction, string> = Object.assign({}, DEFAULTS, parseSaved(settings.get('fps-keys')));

export function codeFor(action: BindAction): string {
  return binds[action];
}

/** Does this event code fire this action? Shift binds match either Shift —
 *  left/right pairs are one key to the player even though the browser
 *  reports two codes. */
export function matchCode(action: BindAction, code: string): boolean {
  const b = binds[action];
  if (code === b) {return true;}
  if (b === 'ShiftLeft' && code === 'ShiftRight') {return true;}
  if (b === 'ShiftRight' && code === 'ShiftLeft') {return true;}
  return false;
}

export function isDown(keys: Record<string, boolean>, action: BindAction): boolean {
  const b = binds[action];
  return Boolean(keys[b] || (b === 'ShiftLeft' && keys['ShiftRight']) || (b === 'ShiftRight' && keys['ShiftLeft']));
}

function persist(): void {
  settings.set('fps-keys', BIND_DEFS.map((d): string => `${d.action}=${binds[d.action]}`).join(','));
}



/** Rebind an action. If the code was bound elsewhere the actions swap —
 *  players expect the stolen key to go back to the thing that lost it. */
export function rebind(action: BindAction, code: string): void {
  const old = binds[action];
  for (const d of BIND_DEFS) {
    if (d.action !== action && binds[d.action] === code) {
      binds[d.action] = old;
    }
  }
  binds[action] = code;
  persist();
}

export function resetAll(): void {
  Object.assign(binds, DEFAULTS);
  persist();
}

// ---- Display --------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
  ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
  AltLeft: 'L-ALT', AltRight: 'R-ALT',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'M4', Mouse4: 'M5',
};

export function codeLabel(code: string): string {
  if (KEY_NAMES[code]) {return KEY_NAMES[code];}
  if (code.startsWith('Key')) {return code.slice(3);}
  if (code.startsWith('Digit')) {return code.slice(5);}
  if (code.startsWith('Numpad')) {return `NUM ${code.slice(6)}`;}
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

// ---- Rebind capture -------------------------------------------------------
// One-shot "press any key" grab. Capture-phase + stopImmediatePropagation so
// the grabbed key never reaches gameplay/menu listeners — Esc cancels.

let capturing = false;

export function isCapturing(): boolean { return capturing; }

let cancelActive: (() => void) | null = null;

export function captureNextInput(onDone: (code: string | null) => void): void {
  capturing = true;
  const finish = (code: string | null): void => {
    capturing = false;
    cancelActive = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouse, true);
    onDone(code);
  };
  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(e.code === 'Escape' ? null : e.code);
  };
  const onMouse = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(`Mouse${e.button}`);
  };
  cancelActive = (): void => finish(null);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouse, true);
}

/** Menu close path: a stranded capture would eat the next gameplay
 *  keypress — cancel it so the bind stays unchanged. */
export function cancelCapture(): void {
  cancelActive?.();
}
