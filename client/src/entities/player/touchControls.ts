/**
 * TouchControls - narrow.one-style split-screen input for coarse-pointer
 * devices. Left half = floating move stick (writes the same keys[] the
 * keyboard path reads, so rebinding still works); right half = drag-to-look
 * through handlers.look. FIRE/JET/JUMP are DOM buttons driving the same
 * flags the mouse path sets. No library - pointer routing only.
 *
 * Instantiated by PlayerInput only when the primary pointer is coarse.
 */
import { codeFor } from '../../core/keybinds.js';
import type { PlayerInput, PlayerInputHandlers } from './input.js';

const MOVE_CODES = {
  f: (): string => codeFor('forward'),
  b: (): string => codeFor('back'),
  l: (): string => codeFor('left'),
  r: (): string => codeFor('right'),
};

const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };

export class TouchControls {
  private moveId = -1;
  private moveOx = 0; private moveOy = 0;
  private base!: HTMLDivElement;
  private knob!: HTMLDivElement;
  private lookId = -1;
  private lookX = 0; private lookY = 0;

  constructor(
    private input: PlayerInput,
    private h: PlayerInputHandlers,
  ) {
    const ui = document.createElement('div');
    css(ui, 'position:fixed;inset:0;z-index:90;pointer-events:none;touch-action:none;');
    document.body.append(ui);
    this.buildStick(ui);
    this.buildLook(ui);
    this.buildButtons(ui);
  }

  /** Floating stick: appears where the left-half touch lands, tracks it. */
  private buildStick(ui: HTMLDivElement): void {
    const zone = document.createElement('div');
    css(zone, 'position:absolute;left:0;top:25%;width:45%;height:75%;pointer-events:auto;');
    ui.append(zone);
    this.base = document.createElement('div');
    css(this.base, 'position:absolute;width:110px;height:110px;border-radius:50%;display:none;' +
      'border:2px solid rgba(140,190,255,0.4);background:rgba(30,50,80,0.18);transform:translate(-50%,-50%);');
    this.knob = document.createElement('div');
    css(this.knob, 'position:absolute;left:50%;top:50%;width:48px;height:48px;border-radius:50%;' +
      'background:rgba(140,190,255,0.35);transform:translate(-50%,-50%);');
    this.base.append(this.knob);
    zone.append(this.base);

    const R = 55; // stick radius px
    const setMove = (dx: number, dy: number): void => {
      const nx = dx / R, ny = dy / R; // -1..1 within the ring
      const keys = this.input.keys;
      keys[MOVE_CODES.f()] = ny < -0.35;
      keys[MOVE_CODES.b()] = ny > 0.35;
      keys[MOVE_CODES.l()] = nx < -0.35;
      keys[MOVE_CODES.r()] = nx > 0.35;
      css(this.knob, `position:absolute;left:50%;top:50%;width:48px;height:48px;border-radius:50%;` +
        `background:rgba(140,190,255,0.35);transform:translate(calc(-50% + ${Math.max(-R, Math.min(R, dx))}px),calc(-50% + ${Math.max(-R, Math.min(R, dy))}px));`);
    };
    zone.addEventListener('touchstart', (e): void => {
      if (this.moveId >= 0) {return;}
      const t = e.changedTouches[0]!;
      this.moveId = t.identifier;
      this.moveOx = t.clientX; this.moveOy = t.clientY;
      css(this.base, `position:absolute;width:110px;height:110px;border-radius:50%;display:block;` +
        `border:2px solid rgba(140,190,255,0.4);background:rgba(30,50,80,0.18);transform:translate(-50%,-50%);` +
        `left:${t.clientX}px;top:${t.clientY}px;`);
      setMove(0, 0);
      e.preventDefault();
    }, { passive: false });
    zone.addEventListener('touchmove', (e): void => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.moveId) {setMove(t.clientX - this.moveOx, t.clientY - this.moveOy);}
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent): void => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.moveId) {
          this.moveId = -1;
          this.base.style.display = 'none';
          const keys = this.input.keys;
          keys[MOVE_CODES.f()] = keys[MOVE_CODES.b()] = keys[MOVE_CODES.l()] = keys[MOVE_CODES.r()] = false;
        }
      }
    };
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
  }

  /** Right half drag = mouse-look deltas through the same handler path. */
  private buildLook(ui: HTMLDivElement): void {
    const zone = document.createElement('div');
    css(zone, 'position:absolute;right:0;top:0;width:55%;height:100%;pointer-events:auto;');
    ui.append(zone);
    zone.addEventListener('touchstart', (e): void => {
      if (this.lookId >= 0) {return;}
      const t = e.changedTouches[0]!;
      this.lookId = t.identifier;
      this.lookX = t.clientX; this.lookY = t.clientY;
      e.preventDefault();
    }, { passive: false });
    zone.addEventListener('touchmove', (e): void => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) {continue;}
        if (!this.input.frozen) {
        // ×2 - a finger drag covers far less ground per swipe than a
        // mouse pad does per flick; the handler applies sens on top.
        this.h.look((t.clientX - this.lookX) * 2, (t.clientY - this.lookY) * 2);
        }
        this.lookX = t.clientX; this.lookY = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent): void => {
      for (const t of e.changedTouches) {if (t.identifier === this.lookId) {this.lookId = -1;}}
    };
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
  }

  private btn(ui: HTMLDivElement, label: string, right: number, bottom: number, on: () => void, off: () => void): void {
    const b = document.createElement('div');
    b.textContent = label;
    css(b, `position:absolute;right:${right}px;bottom:${bottom}px;width:64px;height:64px;border-radius:50%;` +
      'display:flex;align-items:center;justify-content:center;pointer-events:auto;user-select:none;' +
      'font:11px monospace;color:#cfe3ff;border:2px solid rgba(140,190,255,0.45);background:rgba(30,50,80,0.3);');
    ui.append(b);
    let held = false;
    b.addEventListener('touchstart', (e): void => { if (!held) {held = true; on();} e.preventDefault(); e.stopPropagation(); }, { passive: false });
    const off_ = (e: TouchEvent): void => { if (held) {held = false; off();} e.preventDefault(); };
    b.addEventListener('touchend', off_);
    b.addEventListener('touchcancel', off_);
  }

  private buildButtons(ui: HTMLDivElement): void {
    const inp = this.input;
    this.btn(ui, 'FIRE', 20, 96,
      () => { inp.keys['Mouse0'] = true; inp.mouseHeld = true; inp.firePending = true; inp.needsRelease = false; },
      () => { inp.keys['Mouse0'] = false; inp.mouseHeld = false; });
    this.btn(ui, 'JET', 100, 40,
      () => { inp.jetPending = true; },
      () => { inp.jetPending = false; });
    this.btn(ui, 'JMP', 20, 190,
      () => { inp.jumpHeld = true; inp.keys[codeFor('ski')] = true; },
      () => { inp.jumpHeld = false; inp.keys[codeFor('ski')] = false; });
  }
}
