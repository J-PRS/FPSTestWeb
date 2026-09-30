// Demo UI - HTML overlay for playback controls.
// Creates a minimal, non-intrusive control bar with play/pause, seek, speed.

import { initTimeline, initControls, btnStyle } from './demoUIBuild.js';

export interface DemoUICallbacks {
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (speed: number) => void;
  onLoop: (loop: boolean) => void;
  onStop: () => void;
  onSave: () => void;
  onLoad: (file: File) => void;
  onRecordToggle: () => void;
  onVideoToggle: () => void;
}

export class DemoUI {
  private container: HTMLDivElement;
  timeline!: HTMLInputElement;
  timelineWrap!: HTMLDivElement;
  markerOverlay!: HTMLDivElement;
  private timeLabel!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  speedSelect!: HTMLSelectElement;
  loopBtn!: HTMLButtonElement;
  saveBtn!: HTMLButtonElement;
  videoBtn!: HTMLButtonElement;
  loadInput!: HTMLInputElement;
  private statusLabel!: HTMLSpanElement;
  private lastTimelineDuration = -1;

  callbacks: DemoUICallbacks | null = null;
  private visible = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'demo-ui';
    this.container.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.75); color: #fff; padding: 8px 16px;
      border-radius: 8px; display: none; gap: 8px; align-items: center;
      font-family: monospace; font-size: 13px; z-index: 10000;
      user-select: none; backdrop-filter: blur(4px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;

    // Play/Pause button
    this.playBtn = document.createElement('button');
    this.playBtn.textContent = '▶';
    this.playBtn.style.cssText = this.btnStyle('#333');
    this.playBtn.title = 'Play/Pause';
    this.playBtn.addEventListener('click', () => this.callbacks?.onPlayPause());

    // Stop button
    this.stopBtn = document.createElement('button');
    this.stopBtn.textContent = '■';
    this.stopBtn.style.cssText = this.btnStyle('#333');
    this.stopBtn.title = 'Stop';
    this.stopBtn.addEventListener('click', () => this.callbacks?.onStop());

    this.initTimeline();

    // Time label
    this.timeLabel = document.createElement('span');
    this.timeLabel.textContent = '0.0 / 0.0s';
    this.timeLabel.style.cssText = 'min-width: 100px; text-align: center;';

    this.initControls();

    // Load button (triggers file input)
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.style.cssText = this.btnStyle('#2a3a5a');
    loadBtn.title = 'Load demo from file';
    loadBtn.addEventListener('click', () => this.loadInput.click());

    // Status label
    this.statusLabel = document.createElement('span');
    this.statusLabel.style.cssText = 'min-width: 60px; color: #aaa;';

    // Assemble
    this.container.appendChild(this.playBtn);
    this.container.appendChild(this.stopBtn);
    this.container.appendChild(this.timelineWrap);
    this.container.appendChild(this.timeLabel);
    this.container.appendChild(this.speedSelect);
    this.container.appendChild(this.loopBtn);
    this.container.appendChild(this.saveBtn);
    this.container.appendChild(this.videoBtn);
    this.container.appendChild(loadBtn);
    this.container.appendChild(this.loadInput);
    this.container.appendChild(this.statusLabel);

    document.body.appendChild(this.container);
  }

  private initTimeline(): void { initTimeline(this); }
  private initControls(): void { initControls(this); }
  private btnStyle(bgColor: string): string { return btnStyle(bgColor); }

  setCallbacks(callbacks: DemoUICallbacks): void {
    this.callbacks = callbacks;
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
  }

  destroy(): void {
    this.container.remove();
  }

  get isVisible(): boolean { return this.visible; }

  setVideoRecording(on: boolean): void {
    this.videoBtn.textContent = on ? '■' : 'MP4';
    this.videoBtn.style.background = on ? '#a33' : '#5a2a2a';
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  setRecording(_recording: boolean): void {
    // No-op: REC button removed from UI
  }

  setTime(current: number, duration: number): void {
    if (duration !== this.lastTimelineDuration) {
      this.timeline.max = String(duration);
      this.lastTimelineDuration = duration;
    }
    this.timeline.value = String(current);
    this.timeLabel.textContent = `${current.toFixed(1)} / ${duration.toFixed(1)}s`;
  }

  setLoopActive(loop: boolean): void {
    if (loop) {
      this.loopBtn.classList.add('active');
      this.loopBtn.style.background = '#5a5a2a';
    } else {
      this.loopBtn.classList.remove('active');
      this.loopBtn.style.background = '#333';
    }
  }

  setStatus(text: string): void {
    this.statusLabel.textContent = text;
  }

  setSpeed(speed: number): void {
    this.speedSelect.value = String(speed);
  }

  setMarkers(hitTimes: { t: number; hot: boolean }[], firedTimes: { t: number; hot: boolean }[], duration: number): void {
    this.clearMarkers();
    if (duration <= 0) return;
    // Cold = background noise in the clip window — grey, unlit, so the
    // featured shot's markers pop instead of drowning in unrelated fire.
    for (const { t, hot } of hitTimes) {
      this.markerOverlay.appendChild(hot
        ? this.createMarker(t, duration, '#ff4444', 'rgba(255,68,68,0.8)')
        : this.createMarker(t, duration, '#555', 'transparent'));
    }
    for (const { t, hot } of firedTimes) {
      this.markerOverlay.appendChild(hot
        ? this.createMarker(t, duration, '#4488ff', 'rgba(68,136,255,0.8)')
        : this.createMarker(t, duration, '#444', 'transparent'));
    }
  }

  private createMarker(t: number, duration: number, color: string, shadow: string): HTMLElement {
    const pct = Math.max(0, Math.min(1, t / duration)) * 100;
    const marker = document.createElement('div');
    marker.style.cssText = `
      position: absolute; top: 0; bottom: 0;
      left: ${pct}%; width: 2px; margin-left: -1px;
      background: ${color}; pointer-events: none;
      box-shadow: 0 0 3px ${shadow};
    `;
    return marker;
  }

  clearMarkers(): void {
    while (this.markerOverlay.firstChild) {
      this.markerOverlay.removeChild(this.markerOverlay.firstChild);
    }
  }
}
