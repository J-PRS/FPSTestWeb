/**
 * PlayerInput — owns the DOM listeners and raw input state Player used to
 * carry inline. Player drives game semantics through the handlers object;
 * this class just translates key/mouse events into flags + callbacks.
 * The ESC-menu fields (invert-Y, sensitivity, volume) live here too —
 * they're input plumbing, not gameplay.
 */

import { matchCode, type BindAction } from '../../core/keybinds.js';
import { settings } from '../../core/settings.js';
import { audio } from '../../core/audio.js';

/** Actions a press can trigger — Player supplies the implementations. */
export interface PlayerInputHandlers {
  isSpectating(): boolean;
  toggleSpectator(): void;
  beltItem(): 'disc' | 'grenade';
  melee(): void;
  toggleCamera(): void;
  skillPress(): void;
  skillRelease(): void;
  /** Hold-out secondary bind — wid is the loadout-space weapon id. */
  secondaryDown(wid: number): void;
  secondaryUp(wid: number): void;
  selectSlot(i: number): void;
  cycleWeapon(step: number): void;
  /** Raw mouse deltas; Player applies sens/invertY/clamp to yaw/pitch. */
  look(dx: number, dy: number): void;
}

export class PlayerInput {
  keys: Record<string, boolean> = {};
  mouseHeld = false;
  firePending = false;
  // Railgun kill-refund zeroes the cooldown — but the shot is still held,
  // so without this the same click re-fires the gun on kill. Require a
  // mouse release before the next shot.
  needsRelease = false;
  jetPending = false;
  jumpHeld = false;
  discHeld = false;
  grenadeHeld = false;
  // When true, keyboard/mouse input is ignored (demo playback)
  frozen = false;
  invertY = settings.get('fps-invert-y');
  sensitivity = settings.get('fps-sens');
  private wheelAcc = 0; // accumulates deltaY for smooth-scroll mice

  constructor(private h: PlayerInputHandlers) {
    this.bindInput();
    this.bindMenuControls();
  }

  clearAll(): void {
    this.keys = {};
    this.mouseHeld = false;
    this.firePending = false;
    this.jetPending = false;
    this.jumpHeld = false;
    this.discHeld = false;
    this.grenadeHeld = false;
  }

  private bindInput(): void {
    const h = this.h;
    document.addEventListener('keydown', (e) => {
      if (this.frozen) return;
      this.keys[e.code] = true;
      if (matchCode('spectate', e.code) && !e.repeat) h.toggleSpectator();
      // Spectating: only the spectate toggle and raw movement keys (tracked
      // above for the fly cam) respond — no weapons, skills, camera flips
      if (h.isSpectating()) return;
      for (const a of SECONDARY_BINDS) {
        if (matchCode(a.action, e.code)) {
          h.secondaryDown(a.wid);
          break;
        }
      }
      if (matchCode('jump', e.code)) this.jumpHeld = true;
      if (matchCode('belt', e.code)) {
        if (h.beltItem() === 'disc') this.discHeld = true;
        else this.grenadeHeld = true;
      }
      if (matchCode('melee', e.code)) h.melee();
      if (matchCode('camera', e.code)) h.toggleCamera();
      if (matchCode('skill', e.code) && !e.repeat) h.skillPress();
      for (let i = 0; i < LOADOUT_SLOTS; i++) {
        if (matchCode(`slot${i}` as BindAction, e.code)) h.selectSlot(i);
      }
    });
    // Mouse wheel cycles weapons (down = next, up = previous). Accumulate
    // deltaY so smooth-scroll/trackpads switch once per gesture, not per tick.
    document.addEventListener('wheel', (e) => {
      if (this.frozen) return;
      if (!document.pointerLockElement) return;
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) < 40) return;
      const step = this.wheelAcc > 0 ? 1 : -1;
      this.wheelAcc = 0;
      h.cycleWeapon(step);
    }, { passive: true });
    document.addEventListener('keyup', (e) => {
      if (this.frozen) return;
      this.keys[e.code] = false;
      if (matchCode('jump', e.code)) this.jumpHeld = false;
      if (matchCode('skill', e.code)) h.skillRelease();
      if (matchCode('belt', e.code)) { this.discHeld = false; this.grenadeHeld = false; }
      for (const a of SECONDARY_BINDS) {
        if (matchCode(a.action, e.code)) { h.secondaryUp(a.wid); break; }
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (this.frozen) return;
      if (!document.pointerLockElement) return; // ignore clicks that lock the cursor
      this.keys[`Mouse${e.button}`] = true;
      if (e.button === 0) { this.firePending = true; this.mouseHeld = true; this.needsRelease = false; }
      if (e.button === 2) { this.jetPending = true; }
      // Buttons bound to key actions (keybinds allow Mouse0-4) need the
      // same press/release semantics as keyboard codes
      if (matchCode('jump', `Mouse${e.button}`)) this.jumpHeld = true;
      if (matchCode('skill', `Mouse${e.button}`)) h.skillPress();
      if (matchCode('belt', `Mouse${e.button}`)) {
        if (h.beltItem() === 'disc') this.discHeld = true; else this.grenadeHeld = true;
      }
      if (matchCode('melee', `Mouse${e.button}`)) h.melee();
      if (matchCode('camera', `Mouse${e.button}`)) h.toggleCamera();
    });
    document.addEventListener('mouseup', (e) => {
      if (this.frozen) return;
      this.keys[`Mouse${e.button}`] = false;
      if (e.button === 0) this.mouseHeld = false;
      if (e.button === 2) { this.jetPending = false; }
      if (matchCode('jump', `Mouse${e.button}`)) this.jumpHeld = false;
      if (matchCode('skill', `Mouse${e.button}`)) h.skillRelease();
      if (matchCode('belt', `Mouse${e.button}`)) { this.discHeld = false; this.grenadeHeld = false; }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement && !this.frozen) {
        h.look(e.movementX, e.movementY);
      }
    });
  }

  private bindMenuControls(): void {
    // ESC-menu invert-Y toggle
    const invertYBtn = document.getElementById('invert-y-toggle') as HTMLButtonElement | null;
    if (invertYBtn) {
      invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      invertYBtn.addEventListener('click', () => {
        this.invertY = !this.invertY;
        settings.set('fps-invert-y', this.invertY);
        invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      });
    }

    // ESC-menu sensitivity field (plain decimal input, no steppers).
    // Display scale is ×10 the internal multiplier so default shows "10"
    // and whole numbers give coarse-but-usable steps.
    const sensInput = document.getElementById('sens-input') as HTMLInputElement | null;
    if (sensInput) {
      sensInput.value = (this.sensitivity * 10).toString();
      // Click/focus selects the whole value so typing replaces it outright
      sensInput.addEventListener('focus', () => sensInput.select());
      sensInput.addEventListener('input', () => {
        const v = parseFloat(sensInput.value);
        if (!isFinite(v)) return;
        this.sensitivity = Math.max(0.5, Math.min(100, v)) / 10;
        settings.set('fps-sens', this.sensitivity);
      });
      // Don't let WASD-type keys inside the field reach game input
      sensInput.addEventListener('keydown', (e) => e.stopPropagation());
    }

    const volInput = document.getElementById('vol-input') as HTMLInputElement | null;
    if (volInput) {
      volInput.value = audio.getVolume().toString();
      volInput.addEventListener('input', () => {
        const v = parseFloat(volInput.value);
        if (isFinite(v)) audio.setVolume(Math.max(0, Math.min(1, v)));
      });
      volInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
  }
}

const LOADOUT_SLOTS = 4;

const SECONDARY_BINDS: { action: BindAction; wid: number }[] = [
  { action: 'secPistol', wid: 12 },
  { action: 'secRevolver', wid: 13 },
  { action: 'secShotgun', wid: 9 },
];
