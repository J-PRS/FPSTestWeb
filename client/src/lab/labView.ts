/**
 * Sim lab view — a self-contained fullscreen panel (own canvas, own
 * WebGLRenderer, own scene) opened from the ESC menu's SIM LAB button.
 * The game renderer, loop, and input stack never see it: the lab runs
 * its own rAF while open and tears everything down on close/switch.
 *
 * Adding a scenario = one entry in SCENARIOS (scenarios.ts) — the list,
 * preview, and dump panes pick it up automatically.
 */
import * as THREE from 'three';
import { SCENARIOS, type LabInstance } from './scenarios.js';
import { vfxScene, vfxBatcher, setVfxCamOverride } from '../effects/vfxRuntime.js';
import { setRibbonCamera } from '../effects/RibbonTrail.js';

const TICK = 1 / 60;
const DUMP_MS = 200;

class LabView {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private fallbackScene = new THREE.Scene();
  // Scenario content lives in ONE group inside the VFX scene, so real
  // trails/ribbons/explosions (bound to the game's quarks batcher) render
  // unchanged — the lab hosts the real systems instead of cloning them.
  private labRoot = new THREE.Group();
  private hiddenSiblings: THREE.Object3D[] = [];
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  private dumpEl: HTMLElement;
  private blurbEl: HTMLElement;
  private listEl: HTMLElement;
  private instance: LabInstance | null = null;
  private activeId = '';
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private dumpAt = 0;
  // Orbit state — drag rotates, wheel dollies. Deliberately not the game
  // camera stack: lab controls are independent and dead simple.
  private yaw = 0.7;
  private pitch = 0.55;
  private dist = 70;
  private dragging = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'lab';
    this.root.innerHTML = `
      <div id="lab-head">
        <span class="lab-title">SIM LAB</span>
        <button id="lab-close">CLOSE</button>
        <span class="lab-hint">drag = orbit · wheel = zoom</span>
      </div>
      <div id="lab-list"></div>
      <div id="lab-center">
        <canvas id="lab-canvas"></canvas>
        <div id="lab-blurb"></div>
      </div>
      <div id="lab-dump"></div>`;
    document.body.append(this.root);
    this.canvas = this.root.querySelector('#lab-canvas')!;
    this.dumpEl = this.root.querySelector('#lab-dump')!;
    this.blurbEl = this.root.querySelector('#lab-blurb')!;
    this.listEl = this.root.querySelector('#lab-list')!;
    this.root.querySelector('#lab-close')!.addEventListener('click', () => this.close());

    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.className = 'lab-item';
      btn.dataset.id = s.id;
      btn.innerHTML = `${s.name}<span class="lab-item-blurb">${s.blurb}</span>`;
      btn.addEventListener('click', () => this.select(s.id));
      this.listEl.append(btn);
    }

    this.canvas.addEventListener('pointerdown', () => { this.dragging = true; });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) {return;}
      this.yaw -= e.movementX * 0.006;
      this.pitch = Math.max(0.05, Math.min(1.5, this.pitch + e.movementY * 0.006));
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(15, Math.min(300, this.dist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });

    // ESC closes the lab — capture phase so it beats the menu toggle in
    // overlayInput (which would otherwise open/close the ESC menu under
    // the lab in the same keystroke).
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.open) {
        e.stopPropagation();
        this.close();
      }
    }, true);
  }

  get open(): boolean { return this.root.classList.contains('open'); }

  /** Active scenario's dump rows for the Alt+Q clipboard — undefined
   *  when the lab is closed or nothing is running. */
  dumpRows(): [string, [string, string][]] | undefined {
    return this.instance ? [this.activeId, this.instance.dump()] : undefined;
  }

  /** The scene the lab renders — the game's VFX-owning scene when it
   *  exists (real quarks/ribbons live there), else a private fallback. */
  private world(): THREE.Scene { return vfxScene() ?? this.fallbackScene; }

  toggle(): void { if (this.open) {this.close();} else {this.show();} }

  show(): void {
    const w = this.world();
    if (!this.labRoot.parent) {w.add(this.labRoot);}
    // Hide the game world's own objects while the lab is up — the batcher
    // and labRoot stay visible; everything restores on close.
    this.hiddenSiblings = [];
    for (const o of w.children) {
      if (o === this.labRoot || o === vfxBatcher() || !o.visible) {continue;}
      o.visible = false;
      this.hiddenSiblings.push(o);
    }
    setVfxCamOverride(this.camera.position);
    this.root.classList.add('open');
    if (!this.instance) {this.select(SCENARIOS[0]!.id);}
    this.lastT = performance.now();
    this.loop();
  }

  close(): void {
    this.root.classList.remove('open');
    cancelAnimationFrame(this.raf);
    setVfxCamOverride(null);
    for (const o of this.hiddenSiblings) {o.visible = true;}
    this.hiddenSiblings = [];
    // labRoot borrows the LIVE scene — leave it attached and the last
    // scenario's objects stay visible in-game after close.
    this.labRoot.removeFromParent();
  }

  private select(id: string): void {
    const s = SCENARIOS.find(x => x.id === id);
    if (!s) {return;}
    this.instance?.dispose();
    this.instance = null;
    // Drop any strays a scenario leaked rather than letting them pile
    // up in the lab root across switches — reverse-order removal so the
    // children array mutation can't skip an index.
    for (let i = this.labRoot.children.length - 1; i >= 0; i--) {
      const o = this.labRoot.children[i]!;
      if (!this.statics.has(o)) {this.labRoot.remove(o);}
    }
    this.activeId = id;
    this.blurbEl.textContent = s.blurb;
    this.instance = s.create(this.labRoot as unknown as THREE.Scene);
    for (const el of this.listEl.querySelectorAll('.lab-item')) {
      el.classList.toggle('active', (el as HTMLElement).dataset.id === id);
    }
    this.acc = 0;
  }

  private statics = new Set<THREE.Object3D>();

  private ensureRenderer(): void {
    if (this.renderer) {return;}
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    const grid = new THREE.GridHelper(120, 24, 0x22384F, 0x14202E);
    const light = new THREE.AmbientLight(0xFFFFFF, 1.2);
    this.statics.add(grid).add(light);
    this.labRoot.add(grid, light);
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.ensureRenderer();
    const r = this.renderer!;

    const now = performance.now();
    let frame = (now - this.lastT) / 1000;
    this.lastT = now;
    if (frame > 0.25) {frame = 0.25;} // tab-unfreeze clamp, not a sim property
    this.acc += frame;
    while (this.acc >= TICK) {
      this.instance?.tick(TICK);
      this.acc -= TICK;
    }
    this.instance?.sync();

    if (now >= this.dumpAt && this.instance) {
      this.dumpAt = now + DUMP_MS;
      this.dumpEl.innerHTML = '';
      for (const [k, v] of this.instance.dump()) {
        const row = document.createElement('div');
        row.className = 'lab-kv';
        row.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
        this.dumpEl.append(row);
      }
    }

    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (cw && ch && (this.canvas.width !== cw || this.canvas.height !== ch)) {
      r.setSize(cw, ch, false);
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
    }
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      Math.sin(this.yaw) * cp * this.dist,
      sp * this.dist,
      Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(0, 0, 0);
    // Billboard ribbons and the quarks distance-pause steer at whichever
    // camera the game gameLoop set this frame — repoint both at ours.
    setVfxCamOverride(this.camera.position);
    setRibbonCamera(this.camera.position);
    r.render(this.world(), this.camera);
  };
}

let lab: LabView | null = null;

// Alt+Q hooks the active scenario dump through the same window-provider
// convention __trailDump uses — diagDump stays decoupled from the lab.
declare global {
  interface Window { __labDump?: () => [string, [string, string][]] | undefined }
}

/** Wire the SIM LAB button in the ESC menu. One call from overlayInput —
 *  that's the whole blast radius outside this module. The GUN LAB
 *  sibling opens the standalone viewer page in a second tab — it's an
 *  asset-iteration tool, not an in-match overlay, so it keeps its own
 *  renderer rather than borrowing the game's. */
export function wireLabButton(): void {
  const btn = document.querySelector('#lab-open');
  document.querySelector('#gunlab-open')?.addEventListener('click', () =>
    window.open('gunlab.html', '_blank'));
  if (!btn) {return;}
  window.__labDump = () => (lab?.open ? lab.dumpRows() : undefined);
  btn.addEventListener('click', () => {
    lab ??= new LabView();
    lab.toggle();
  });
}
