/**

 * PlayerInput — owns the DOM listeners and raw input state Player used to

 * carry inline. Player drives game semantics through the handlers object;

 * this class just translates key/mouse events into flags + callbacks.

 * The ESC-menu fields (invert-Y, sensitivity, volume) live here too —

 * they're input plumbing, not gameplay.

 */



import { matchCode, type BindAction } from '../../core/keybinds.js';

import { settings } from '../../core/settings.js';

import { feedMode } from '../../feed/feedMode.js';

import { audio } from '../../core/audio.js';

import { ChildLogger } from '../../core/Logger.js';

const logger = new ChildLogger('Input');

const LOADOUT_SLOTS = 4;



/** Actions a press can trigger — Player supplies the implementations. */

export interface PlayerInputHandlers {

  isSpectating(): boolean;

  /** Dead body — clicks mean spectate/respawn, not weapons or jets. */

  isDead(): boolean;

  /** Corpse-cam is orbiting a teammate — mouse steers the boom, not the aim. */

  isDeadSpectating(): boolean;

  /** Click while dead: enter teammate orbit / cycle targets — dir=1 next,

   *  dir=-1 previous. Cycling off an end lands on ghost free-fly. */

  deadSpectateCycle(dir?: 1 | -1): void;

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



const aspect = (): number => window.innerWidth / Math.max(1, window.innerHeight);

/* Numeric menu fields — inputmode only hints the mobile keyboard; strip
   non-numeric chars on input so letters can't sit in the box (parsing
   already ignores them, but a field full of junk reads broken). */
const digitsOnly = (el: HTMLInputElement, decimal = true): void => {
  const re = decimal ? /[^\d.]/g : /\D/g;
  el.addEventListener('input', (): void => {
    const clean = el.value.replace(re, '');
    if (clean !== el.value) {el.value = clean;}
  });
};

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

  private phantomDrops = 0;   // dropped isolated-spike deltas since last report
  private lastMoveX = 0;      // previous event delta — phantom spikes are
  private lastMoveY = 0;      // isolated, real flicks have ramp-up neighbors

  private phantomLogAt = 0;   // report throttle — a sick mouse spams otherwise



  constructor(private h: PlayerInputHandlers) {

    this.bindInput();

    this.bindMenuControls();

    // Phones/tablets: split-screen touch controls (left stick, right
    // look-drag, FIRE/JET/JMP buttons). Not in feed mode - the clip
    // viewer is playback, not gameplay, and the overlay would sit on it.
    if (window.matchMedia('(pointer: coarse)').matches && !feedMode.on) {
      void import('./touchControls.js').then((m): void => { this.touch = new m.TouchControls(this, h); });
    }

  }

  touch?: unknown; // TouchControls - coarse-pointer-only split controls



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

    // Chords with modifiers belong to the browser/dev shortcuts, not the

    // game — Alt+Q copies logs but matchCode only saw 'KeyQ' and toggled

    // whatever skill was equipped (cloak → transparent gun).

    if (e.ctrlKey || e.altKey || e.metaKey) {return;}

    if (matchCode('spectate', e.code) && !e.repeat) {h.toggleSpectator();}

    // Die+spectate works from the ghost cam too — suicide flips isDead,

    // which owns the cam and drops the spectating flag on its own.

    if (matchCode('dieSpectate', e.code) && !e.repeat) {h.dieSpectate();}

    // Dead: respawn and the corpse cam only — weapons/skills/jets while

    // dead do nothing but queue junk for the first frame back alive

    // (a melee press from the death cam swung the ghost's fist).

    if (h.isDead()) {

      if (!e.repeat && matchCode('respawn', e.code)) {h.respawn();}

      if (matchCode('camera', e.code)) {h.toggleCamera();}

      return;

    }

    // Spectating: only the spectate toggle and raw movement keys (tracked

    // above for the fly cam) respond — no weapons, skills, camera flips

    if (matchCode('jump', e.code)) {this.jumpHeld = true;}

    if (h.isSpectating()) {return;}

    if (matchCode('fire', e.code)) {this.firePending = true; this.mouseHeld = true; this.needsRelease = false;}

    if (matchCode('jet', e.code)) {this.jetPending = true;}

    if (matchCode('sidearm', e.code)) {h.secondaryDown(h.sidearmWid());}

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

    for (let i = 0; i < LOADOUT_SLOTS; i += 1) {

      if (matchCode(`slot${i}` as BindAction, code)) {return i;}

    }

    return -1;

  }



  // Corpse clicks are spectate/respawn — queuing fire/jet here would
  // fire a shot or burn fuel the first frame back alive.
  private deadMouseDown(e: MouseEvent): void {
    const { h } = this;
    if (e.button === 0) {
      // Orbiting a teammate: LMB steps back through the ring; free-fly
      // ghost keeps LMB = respawn so a click still revives.
      if (h.isDeadSpectating()) {h.deadSpectateCycle(-1);} else {h.respawn();}
    }
    if (e.button === 2) {h.deadSpectateCycle(1); e.preventDefault();}
  }

  private bindInput(): void {

    const {h} = this;

    document.addEventListener('keydown', (e): void => this.onKeyDown(e));

    // Mouse wheel cycles weapons (down = next, up = previous). Accumulate

    // deltaY so smooth-scroll/trackpads switch once per gesture, not per tick.

    document.addEventListener('wheel', (e): void => {

      if (this.frozen) {return;}

      if (!document.pointerLockElement) {return;}

      this.wheelAcc += e.deltaY;

      if (Math.abs(this.wheelAcc) < 40) {return;}

      const step = this.wheelAcc > 0 ? 1 : -1;

      this.wheelAcc = 0;

      h.cycleWeapon(step);

    }, { passive: true });

    document.addEventListener('keyup', (e): void => {

      if (this.frozen) {return;}

      this.keys[e.code] = false;

      if (matchCode('jump', e.code)) {this.jumpHeld = false;}

      if (matchCode('fire', e.code)) {this.mouseHeld = false;}

      if (matchCode('jet', e.code)) {this.jetPending = false;}

      if (matchCode('skill', e.code)) {h.skillRelease();}

      if (matchCode('belt', e.code)) {this.beltHeld = false;}

      if (matchCode('sidearm', e.code)) {h.secondaryUp();}

    });

    document.addEventListener('mousedown', (e): void => {

      if (this.frozen) {return;}

      if (!document.pointerLockElement) {return;} // ignore clicks that lock the cursor

      this.keys[`Mouse${e.button}`] = true;

      if (h.isDead()) { this.deadMouseDown(e); return; }

      if (matchCode('fire', `Mouse${e.button}`)) { this.firePending = true; this.mouseHeld = true; this.needsRelease = false; }

      if (e.button === 1) { this.midHeld = !this.midHeld; e.preventDefault(); }

      if (matchCode('jet', `Mouse${e.button}`)) { this.jetPending = true; }

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

    document.addEventListener('mouseup', (e): void => {

      if (this.frozen) {return;}

      this.keys[`Mouse${e.button}`] = false;

      if (matchCode('fire', `Mouse${e.button}`)) {this.mouseHeld = false;}

      if (matchCode('jet', `Mouse${e.button}`)) { this.jetPending = false; }

      if (matchCode('jump', `Mouse${e.button}`)) {this.jumpHeld = false;}

      if (matchCode('skill', `Mouse${e.button}`)) {h.skillRelease();}

      if (matchCode('belt', `Mouse${e.button}`)) {this.beltHeld = false;}

    });

    document.addEventListener('contextmenu', (e): void => e.preventDefault());

    // Chrome's pointer-lock quirk: mousemoves queued before lock fire after

    // it, each carrying a delta from the old cursor position — up to a full

    // screen of phantom movement per event (~50-120° spinout warns). It isn't

    // always a single event, so swallow everything for a short settle window

    // rather than just the first one. Clamped per-event deltas stay: a real

    // violent flick is <100px anyway.

    document.addEventListener('pointerlockchange', (): void => {

      if (document.pointerLockElement) {this.lockSettleUntil = performance.now() + 80;}

      // Lock dropped (ESC menu, alt-tab, OS dialog): any held key/button's

      // release may never reach the page — a missed mouseup leaves jets

      // burning till the tank empties, the classic phantom launch.

      else {this.clearAll();}

    });

    // Same hazard when the window loses focus mid-hold.

    window.addEventListener('blur', (): void => this.clearAll());

    document.addEventListener('mousemove', (e): void => {

      if (!document.pointerLockElement || this.frozen) {return;}

      if (performance.now() < this.lockSettleUntil) {return;}

      // Phantom deltas arrive as one huge ISOLATED event bracketed by
      // stillness; a real flick always ramps — the previous event is
      // already large. unadjustedMovement kills most of the bug upstream;
      // this catches what leaks through without ever eating a legit
      // swipe at any DPI (magnitude thresholds can't tell 4m/s@1600dpi
      // from the bug — neighbors can).
      const mx = e.movementX;

      const my = e.movementY;

      if ((Math.abs(mx) > 500 || Math.abs(my) > 500) && Math.abs(this.lastMoveX) < 50 && Math.abs(this.lastMoveY) < 50) {
        this.lastMoveX = mx; this.lastMoveY = my;

        this.phantomDrops += 1;

        const now = performance.now();

        if (now >= this.phantomLogAt) {

          this.phantomLogAt = now + 2000;

          // WARN so dev hosts flash it in the conn-banner (complaint feed)
          // — visible proof the clamp fired, for swipe testing.
          logger.warn(`phantom delta dropped x${this.phantomDrops} (${mx},${my})`);

          this.phantomDrops = 0;

        }

        return;

      }

      this.lastMoveX = mx; this.lastMoveY = my;
      if (this.midHeld || h.isDeadSpectating()) {h.orbitLook(mx, my);} else {h.look(mx, my);}

    });

  }



  private bindMenuControls(): void {

    // Display name — cosmetic tag the join handshake ships; lives in the

    // menu-side profile block, not the lobby (it's an identity, not a

    // connection parameter).

    const nameInput = document.querySelector('#name-input') as HTMLInputElement | null;

    if (nameInput) {

      nameInput.value = settings.get('fps-name');

      nameInput.addEventListener('focus', (): void => nameInput.select());

      nameInput.addEventListener('input', (): void => settings.set('fps-name', nameInput.value.trim()));

      nameInput.addEventListener('keydown', (e): void => e.stopPropagation());

    }



    // ESC-menu invert-Y toggle — .tog markup carries the state box;

    // the label writer flips .on (the box IS the state readout).

    const invertYBtn = document.querySelector('#invert-y-toggle') as HTMLButtonElement | null;

    if (invertYBtn) {

      invertYBtn.classList.toggle('on', this.invertY);

      invertYBtn.addEventListener('click', (): void => {

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

      // Two synced fields: the raw sens number AND cm/360 — the universal
      // FPS unit (players know "13cm", not "0.8"). Edit either; they stay
      // locked. cm/360 @800DPI: 360 / (sens*0.002rad*deg*314.96c/cm).
      const sensCm = document.querySelector('#sens-cm') as HTMLInputElement | null;
      const DEG_PER_CM = 0.002 * (180 / Math.PI) * (800 / 2.54); // ~36.1°/cm per sens unit
      const paintCm = (): void => {
        if (sensCm && document.activeElement !== sensCm) {
          sensCm.value = (360 / (this.sensitivity * DEG_PER_CM)).toFixed(1);
        }
      };
      paintCm();

      // Click/focus selects the whole value so typing replaces it outright

      digitsOnly(sensInput);
      if (sensCm) {digitsOnly(sensCm);}

      sensInput.addEventListener('focus', (): void => sensInput.select());

      sensInput.addEventListener('input', (): void => {

        const v = Number.parseFloat(sensInput.value);

        if (!Number.isFinite(v)) {return;}

        this.sensitivity = Math.max(0.5, Math.min(100, v)) / 10;

        settings.set('fps-sens', this.sensitivity);

        paintCm();

      });

      if (sensCm) {
        sensCm.addEventListener('focus', (): void => sensCm.select());
        sensCm.addEventListener('input', (): void => {
          const cm = Number.parseFloat(sensCm.value);
          if (!Number.isFinite(cm) || cm <= 0) {return;}
          this.sensitivity = Math.max(0.05, Math.min(10, 360 / (cm * DEG_PER_CM)));
          settings.set('fps-sens', this.sensitivity);
          if (document.activeElement !== sensInput) {sensInput.value = (this.sensitivity * 10).toString();}
        });
        sensCm.addEventListener('keydown', (e): void => e.stopPropagation());
      }

      // Don't let WASD-type keys inside the field reach game input

      sensInput.addEventListener('keydown', (e): void => e.stopPropagation());

    }



    // FOV fields — vertical is the stored/canonical value (camera.fov);

    // horizontal is derived via aspect and edits back-solve to vertical.

    // Live-applied via the fps:set event (main.ts listens).

    const fovInput = document.querySelector('#fov-input') as HTMLInputElement | null;

    const fovHInput = document.querySelector('#fov-h-input') as HTMLInputElement | null;


    if (fovInput && fovHInput) {

      const vToH = (v: number): number => 2 * Math.atan(Math.tan(v * Math.PI / 360) * aspect()) * 180 / Math.PI;

      const hToV = (h: number): number => 2 * Math.atan(Math.tan(h * Math.PI / 360) / aspect()) * 180 / Math.PI;

      const syncH = (): void => { fovHInput.value = String(Math.round(vToH(settings.get('fps-fov')))); };

      fovInput.value = String(settings.get('fps-fov'));

      syncH();

      for (const el of [fovInput, fovHInput]) {

        digitsOnly(el, false); // FOV is rounded to whole degrees anyway

        el.addEventListener('focus', (): void => el.select());

        el.addEventListener('keydown', (e): void => e.stopPropagation());

      }

      const FOV_MIN = 50, FOV_MAX = 160; // 160v ≈ 172°h @16:9 — the fisheye wall

      fovInput.addEventListener('input', (): void => {

        const v = Number.parseFloat(fovInput.value);

        if (!Number.isFinite(v)) {return;}

        settings.set('fps-fov', Math.max(FOV_MIN, Math.min(FOV_MAX, Math.round(v))));

        syncH();

      });

      fovHInput.addEventListener('input', (): void => {

        const h = Number.parseFloat(fovHInput.value);

        if (!Number.isFinite(h)) {return;}

        settings.set('fps-fov', Math.max(FOV_MIN, Math.min(FOV_MAX, Math.round(hToV(h)))));

        fovInput.value = String(settings.get('fps-fov'));

      });

      // Repaint the clamped value on blur — the box shouldn't show a
      // number the setting silently refused.
      for (const el of [fovInput, fovHInput]) {
        el.addEventListener('blur', (): void => {
          fovInput.value = String(settings.get('fps-fov'));
          syncH();
        });
      }

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

      volInput.addEventListener('input', (): void => {

        const v = Number.parseFloat(volInput.value);

        if (Number.isFinite(v)) {audio.setVolume(Math.max(0, Math.min(1, v)));}

        volPaint();

      });

      volInput.addEventListener('keydown', (e): void => e.stopPropagation());

    }



    // Dev-tools row: hidden markup unless this is an operator's host

    // (vite dev / localhost / LAN). A public deploy never reveals it —

    // the buttons' own wiring still runs harmlessly if absent.

    // #dev-tools stays hidden for now (spawn-mode + DEBUG live behind
    // other entry points) — restore the isDevHost reveal here to resurface.



    // Boot-time flags: spawns/debug are read once at module init, so a

    // change persists the setting and reloads rather than half-applying.

    // (Solo/bot mode selection lives in the play hub's OFFLINE tab.)

    const spawnsBtn = document.querySelector('#spawns-toggle') as HTMLButtonElement | null;

    if (spawnsBtn) {

      const label = (): void => { spawnsBtn.textContent = settings.get('fps-spawns') ? 'SPAWNS: RANDOM' : 'SPAWNS: SCRIPTED'; };

      label();

      spawnsBtn.addEventListener('click', (): void => {

        settings.set('fps-spawns', settings.get('fps-spawns') ? 0 : 1);

        window.location.reload();

      });

    }



    const debugBtn = document.querySelector('#debug-toggle') as HTMLButtonElement | null;

    if (debugBtn) {

      const label = (): void => { debugBtn.classList.toggle('on', Boolean(settings.get('fps-debug'))); };

      label();

      debugBtn.addEventListener('click', (): void => {

        settings.set('fps-debug', settings.get('fps-debug') ? 0 : 1);

        // No reload: every debug consumer reads urlParams.debug live (or

        // hears the fps:set event this set() just fired).

        label();

      });

    }



    // Read live per message — no reload needed.

    const ttsBtn = document.querySelector('#tts-chat-toggle') as HTMLButtonElement | null;

    if (ttsBtn) {

      const label = (): void => { ttsBtn.classList.toggle('on', Boolean(settings.get('fps-tts-chat'))); };

      label();

      ttsBtn.addEventListener('click', (): void => {

        settings.set('fps-tts-chat', !settings.get('fps-tts-chat'));

        label();

      });

    }



    // VGS chord letters: layout (typed letters, matches the printed chord)

    // vs physical QWERTY positions (classic Tribes muscle memory). Live —

    // vgs.ts reads the setting per keypress.

    const vgsKeysBtn = document.querySelector('#vgs-keys-toggle') as HTMLButtonElement | null;

    if (vgsKeysBtn) {

      const label = (): void => { vgsKeysBtn.textContent = settings.get('fps-vgs-physical') ? 'VGS KEYS: PHYSICAL' : 'VGS KEYS: LAYOUT'; };

      label();

      vgsKeysBtn.addEventListener('click', (): void => {

        settings.set('fps-vgs-physical', !settings.get('fps-vgs-physical'));

        label();

      });

    }

  }

}



