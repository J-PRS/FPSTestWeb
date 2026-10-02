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

const TICK = 1 / 60;
const DUMP_MS = 200;

class LabView {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
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
    document.body.appendChild(this.root);
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
      this.listEl.appendChild(btn);
    }

    this.canvas.addEventListener('pointerdown', () => { this.dragging = true; });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
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

  toggle(): void { if (this.open) this.close(); else this.show(); }

  show(): void {
    this.root.classList.add('open');
    if (!this.instance) this.select(SCENARIOS[0]!.id);
    this.lastT = performance.now();
    this.loop();
  }

  close(): void {
    this.root.classList.remove('open');
    cancelAnimationFrame(this.raf);
  }

  private select(id: string): void {
    const s = SCENARIOS.find(x => x.id === id);
    if (!s) return;
    this.instance?.dispose();
    this.instance = null;
    // Drop any strays a scenario leaked rather than letting them pile
    // up in the lab scene across switches — reverse-order removal so the
    // children array mutation can't skip an index.
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const o = this.scene.children[i]!;
      if (!this.statics.has(o)) this.scene.remove(o);
    }
    this.activeId = id;
    this.blurbEl.textContent = s.blurb;
    this.instance = s.create(this.scene);
    for (const el of this.listEl.querySelectorAll('.lab-item')) {
      el.classList.toggle('active', (el as HTMLElement).dataset.id === id);
    }
    this.acc = 0;
  }

  private statics = new Set<THREE.Object3D>();

  private ensureRenderer(): void {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    const grid = new THREE.GridHelper(120, 24, 0x22384f, 0x14202e);
    const light = new THREE.AmbientLight(0xffffff, 1.2);
    this.statics.add(grid).add(light);
    this.scene.add(grid, light);
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.ensureRenderer();
    const r = this.renderer!;

    const now = performance.now();
    let frame = (now - this.lastT) / 1000;
    this.lastT = now;
    if (frame > 0.25) frame = 0.25; // tab-unfreeze clamp, not a sim property
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
        this.dumpEl.appendChild(row);
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
    r.render(this.scene, this.camera);
  };
}

let lab: LabView | null = null;

/** Wire the SIM LAB button in the ESC menu. One call from overlayInput —
 *  that's the whole blast radius outside this module. */
export function wireLabButton(): void {
  const btn = document.getElementById('lab-open');
  if (!btn) return;
  btn.addEventListener('click', () => {
    lab ??= new LabView();
    lab.toggle();
  });
}
