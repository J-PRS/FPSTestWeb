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
  /** Dead body — clicks mean spectate/respawn, not weapons or jets. */
  isDead(): boolean;
  /** Corpse-cam is orbiting a teammate — mouse steers the boom, not the aim. */
  isDeadSpectating(): boolean;
  /** Right-click while dead: enter teammate orbit / advance to the next one. */
  deadSpectateCycle(): void;
  toggleSpectator(): void;
  melee(): void;
  toggleCamera(): void;
  skillPress(): void;
  skillRelease(): void;
  /** The loadout-chosen sidearm's slot-space weapon id — resolved at
   *  press time so a mid-match loadout change takes effect immediately. */
  sidearmWid(): number;
  /** Hold-out sidearm bind — wid is the loadout-space weapon id. */
  secondaryDown(wid: number): void;
  /** Releases whatever sidearm is currently held — no arg, the held wid is
   *  the player's state (loadout may have changed while the key was down). */
  secondaryUp(): void;
  selectSlot(i: number): void;
  cycleWeapon(step: number): void;
  deploy(): void;
  /** Deliberate respawn — a server claim, not a local state flip. */
  respawn(): void;
  /** Suicide + spectate in one press: alive = respawn claim then the death
   *  flips to corpse cam; dead = advance the teammate orbit. */
  dieSpectate(): void;
  /** Hurl the carried flag along the aim — a claim the server resolves. */
  throwFlag(): void;
  /** Raw mouse deltas; Player applies sens/invertY/clamp to yaw/pitch. */
  look(dx: number, dy: number): void;
  /** Mouse deltas while the orbit bind is held — swings the camera, not the aim. */
  orbitLook(dx: number, dy: number): void;
}

export class PlayerInput {
  keys: Record<string, boolean> = {};
  mouseHeld = false;
  firePending = false;
  // Railgun kill-refund zeroes the cooldown — but the shot is still held,
  // so without this the same click re-fires the gun on kill. Require a
  // mouse release before the next shot.
  needsRelease = false;
  /** Middle mouse toggles free-look orbit: mouse-look swings the camera
   *  around the body instead of steering aim — model inspection cam. */
  midHeld = false;
  jetPending = false;
  jumpHeld = false;
  beltHeld = false;
  // When true, keyboard/mouse input is ignored (demo playback)
  frozen = false;
  invertY = settings.get('fps-invert-y');
  sensitivity = settings.get('fps-sens');
  private wheelAcc = 0; // accumulates deltaY for smooth-scroll mice
  private lockSettleUntil = 0; // phantom-delta blackout right after pointer lock

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
    this.beltHeld = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const {h} = this;
    if (this.frozen) {return;}
    this.keys[e.code] = true;
    if (matchCode('spectate', e.code) && !e.repeat) {h.toggleSpectator();}
    // Die+spectate works from the ghost cam too — suicide flips isDead,
    // which owns the cam and drops the spectating flag on its own.
    if (matchCode('dieSpectate', e.code) && !e.repeat) {h.dieSpectate();}
    // Spectating: only the spectate toggle and raw movement keys (tracked
    // above for the fly cam) respond — no weapons, skills, camera flips
    if (h.isSpectating()) {return;}
    if (matchCode('sidearm', e.code)) {h.secondaryDown(h.sidearmWid());}
    if (matchCode('jump', e.code)) {this.jumpHeld = true;}
    if (matchCode('belt', e.code)) {this.beltHeld = true;}
    if (matchCode('melee', e.code)) {h.melee();}
    if (matchCode('camera', e.code)) {h.toggleCamera();}
    if (!e.repeat) {
      if (matchCode('skill', e.code)) {h.skillPress();}
      if (matchCode('deploy', e.code)) {h.deploy();}
      if (matchCode('respawn', e.code)) {h.respawn();}
      if (matchCode('throwFlag', e.code)) {h.throwFlag();}
    }
    const slot = this.slotForCode(e.code);
    if (slot >= 0) {h.selectSlot(slot);}
  }

  private slotForCode(code: string): number {
    for (let i = 0; i < LOADOUT_SLOTS; i++) {
      if (matchCode(`slot${i}` as BindAction, code)) {return i;}
    }
    return -1;
  }

  private bindInput(): void {
    const {h} = this;
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Mouse wheel cycles weapons (down = next, up = previous). Accumulate
    // deltaY so smooth-scroll/trackpads switch once per gesture, not per tick.
    document.addEventListener('wheel', (e) => {
      if (this.frozen) {return;}
      if (!document.pointerLockElement) {return;}
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) < 40) {return;}
      const step = this.wheelAcc > 0 ? 1 : -1;
      this.wheelAcc = 0;
      h.cycleWeapon(step);
    }, { passive: true });
    document.addEventListener('keyup', (e) => {
      if (this.frozen) {return;}
      this.keys[e.code] = false;
      if (matchCode('jump', e.code)) {this.jumpHeld = false;}
      if (matchCode('skill', e.code)) {h.skillRelease();}
      if (matchCode('belt', e.code)) {this.beltHeld = false;}
      if (matchCode('sidearm', e.code)) {h.secondaryUp();}
    });
    document.addEventListener('mousedown', (e) => {
      if (this.frozen) {return;}
      if (!document.pointerLockElement) {return;} // ignore clicks that lock the cursor
      this.keys[`Mouse${e.button}`] = true;
      if (h.isDead()) {
        // Corpse clicks are spectate/respawn — queuing fire/jet here would
        // fire a shot or burn fuel the first frame back alive.
        if (e.button === 0) {h.respawn();}
        if (e.button === 2) {h.deadSpectateCycle(); e.preventDefault();}
        return;
      }
      if (e.button === 0) { this.firePending = true; this.mouseHeld = true; this.needsRelease = false; }
      if (e.button === 1) { this.midHeld = !this.midHeld; e.preventDefault(); }
      if (e.button === 2) { this.jetPending = true; }
      // Buttons bound to key actions (keybinds allow Mouse0-4) need the
      // same press/release semantics as keyboard codes
      if (matchCode('jump', `Mouse${e.button}`)) {this.jumpHeld = true;}
      if (matchCode('skill', `Mouse${e.button}`)) {h.skillPress();}
      if (matchCode('belt', `Mouse${e.button}`)) {this.beltHeld = true;}
      if (matchCode('melee', `Mouse${e.button}`)) {h.melee();}
      if (matchCode('camera', `Mouse${e.button}`)) {h.toggleCamera();}
      if (matchCode('respawn', `Mouse${e.button}`)) {h.respawn();}
      if (matchCode('dieSpectate', `Mouse${e.button}`)) {h.dieSpectate();}
      if (matchCode('throwFlag', `Mouse${e.button}`)) {h.throwFlag();}
    });
    document.addEventListener('mouseup', (e) => {
      if (this.frozen) {return;}
      this.keys[`Mouse${e.button}`] = false;
      if (e.button === 0) {this.mouseHeld = false;}
      if (e.button === 2) { this.jetPending = false; }
      if (matchCode('jump', `Mouse${e.button}`)) {this.jumpHeld = false;}
      if (matchCode('skill', `Mouse${e.button}`)) {h.skillRelease();}
      if (matchCode('belt', `Mouse${e.button}`)) {this.beltHeld = false;}
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    // Chrome's pointer-lock quirk: mousemoves queued before lock fire after
    // it, each carrying a delta from the old cursor position — up to a full
    // screen of phantom movement per event (~50-120° spinout warns). It isn't
    // always a single event, so swallow everything for a short settle window
    // rather than just the first one. Clamped per-event deltas stay: a real
    // violent flick is <100px anyway.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) {this.lockSettleUntil = performance.now() + 80;}
    });
    document.addEventListener('mousemove', (e) => {
      if (!document.pointerLockElement || this.frozen) {return;}
      if (performance.now() < this.lockSettleUntil) {return;}
      const mx = Math.max(-800, Math.min(800, e.movementX));
      const my = Math.max(-800, Math.min(800, e.movementY));
      if (this.midHeld || h.isDeadSpectating()) {h.orbitLook(mx, my);} else {h.look(mx, my);}
    });
  }

  private bindMenuControls(): void {
    // ESC-menu invert-Y toggle — .tog markup carries the state box;
    // the label writer flips .on (the box IS the state readout).
    const invertYBtn = document.querySelector('#invert-y-toggle') as HTMLButtonElement | null;
    if (invertYBtn) {
      invertYBtn.classList.toggle('on', this.invertY);
      invertYBtn.addEventListener('click', () => {
        this.invertY = !this.invertY;
        settings.set('fps-invert-y', this.invertY);
        invertYBtn.classList.toggle('on', this.invertY);
      });
    }

    // ESC-menu sensitivity field (plain decimal input, no steppers).
    // Display scale is ×10 the internal multiplier so default shows "10"
    // and whole numbers give coarse-but-usable steps.
    const sensInput = document.querySelector('#sens-input') as HTMLInputElement | null;
    if (sensInput) {
      sensInput.value = (this.sensitivity * 10).toString();
      // Click/focus selects the whole value so typing replaces it outright
      sensInput.addEventListener('focus', () => sensInput.select());
      sensInput.addEventListener('input', () => {
        const v = Number.parseFloat(sensInput.value);
        if (!isFinite(v)) {return;}
        this.sensitivity = Math.max(0.5, Math.min(100, v)) / 10;
        settings.set('fps-sens', this.sensitivity);
      });
      // Don't let WASD-type keys inside the field reach game input
      sensInput.addEventListener('keydown', (e) => e.stopPropagation());
    }

    // FOV field — degrees, live-applied to the world camera via the
    // fps:set event (main.ts listens). Viewmodel cam stays fixed at 55.
    const fovInput = document.querySelector('#fov-input') as HTMLInputElement | null;
    if (fovInput) {
      fovInput.value = String(settings.get('fps-fov'));
      fovInput.addEventListener('focus', () => fovInput.select());
      fovInput.addEventListener('input', () => {
        const v = Number.parseFloat(fovInput.value);
        if (!isFinite(v)) {return;}
        settings.set('fps-fov', Math.max(50, Math.min(140, Math.round(v))));
      });
      fovInput.addEventListener('keydown', (e) => e.stopPropagation());
    }

    const volInput = document.querySelector('#vol-input') as HTMLInputElement | null;
    const volVal = document.querySelector('#vol-val');
    if (volInput) {
      volInput.value = audio.getVolume().toString();
      // Track fill rides --v (webkit needs the gradient; firefox fills
      // via range-progress); the % readout makes the level unambiguous.
      const volPaint = (): void => {
        const pct = Math.round(Number.parseFloat(volInput.value) * 100);
        volInput.style.setProperty('--v', `${pct}%`);
        if (volVal) {volVal.textContent = `${pct}%`;}
      };
      volPaint();
      volInput.addEventListener('input', () => {
        const v = Number.parseFloat(volInput.value);
        if (isFinite(v)) {audio.setVolume(Math.max(0, Math.min(1, v)));}
        volPaint();
      });
      volInput.addEventListener('keydown', (e) => e.stopPropagation());
    }

    // Boot-time flags: spawns/debug are read once at module init, so a
    // change persists the setting and reloads rather than half-applying.
    // (Solo/bot mode selection lives in the play hub's OFFLINE tab.)
    const spawnsBtn = document.querySelector('#spawns-toggle') as HTMLButtonElement | null;
    if (spawnsBtn) {
      const label = () => { spawnsBtn.textContent = settings.get('fps-spawns') ? 'SPAWNS: RANDOM' : 'SPAWNS: SCRIPTED'; };
      label();
      spawnsBtn.addEventListener('click', () => {
        settings.set('fps-spawns', settings.get('fps-spawns') ? 0 : 1);
        location.reload();
      });
    }

    const debugBtn = document.querySelector('#debug-toggle') as HTMLButtonElement | null;
    if (debugBtn) {
      const label = () => { debugBtn.classList.toggle('on', !!settings.get('fps-debug')); };
      label();
      debugBtn.addEventListener('click', () => {
        settings.set('fps-debug', settings.get('fps-debug') ? 0 : 1);
        // No reload: every debug consumer reads urlParams.debug live (or
        // hears the fps:set event this set() just fired).
        label();
      });
    }

    // Read live per message — no reload needed.
    const ttsBtn = document.querySelector('#tts-chat-toggle') as HTMLButtonElement | null;
    if (ttsBtn) {
      const label = () => { ttsBtn.classList.toggle('on', !!settings.get('fps-tts-chat')); };
      label();
      ttsBtn.addEventListener('click', () => {
        settings.set('fps-tts-chat', !settings.get('fps-tts-chat'));
        label();
      });
    }

    // VGS chord letters: layout (typed letters, matches the printed chord)
    // vs physical QWERTY positions (classic Tribes muscle memory). Live —
    // vgs.ts reads the setting per keypress.
    const vgsKeysBtn = document.querySelector('#vgs-keys-toggle') as HTMLButtonElement | null;
    if (vgsKeysBtn) {
      const label = () => { vgsKeysBtn.textContent = settings.get('fps-vgs-physical') ? 'VGS KEYS: PHYSICAL' : 'VGS KEYS: LAYOUT'; };
      label();
      vgsKeysBtn.addEventListener('click', () => {
        settings.set('fps-vgs-physical', !settings.get('fps-vgs-physical'));
        label();
      });
    }
  }
}

const LOADOUT_SLOTS = 4;
