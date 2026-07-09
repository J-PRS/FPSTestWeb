// Demo UI - HTML overlay for playback controls.
// Creates a minimal, non-intrusive control bar with play/pause, seek, speed.

export interface DemoUICallbacks {
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (speed: number) => void;
  onLoop: (loop: boolean) => void;
  onStop: () => void;
  onSave: () => void;
  onLoad: (file: File) => void;
  onRecordToggle: () => void;
}

export class DemoUI {
  private container: HTMLDivElement;
  private timeline: HTMLInputElement;
  private timelineWrap: HTMLDivElement;
  private markerOverlay: HTMLDivElement;
  private timeLabel: HTMLSpanElement;
  private playBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private speedSelect: HTMLSelectElement;
  private loopBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private loadInput: HTMLInputElement;
  private statusLabel: HTMLSpanElement;

  private callbacks: DemoUICallbacks | null = null;
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
    this.playBtn.onclick = () => this.callbacks?.onPlayPause();

    // Stop button
    this.stopBtn = document.createElement('button');
    this.stopBtn.textContent = '■';
    this.stopBtn.style.cssText = this.btnStyle('#333');
    this.stopBtn.title = 'Stop';
    this.stopBtn.onclick = () => this.callbacks?.onStop();

    // Timeline slider — wrapped in a relative container for marker overlay
    this.timeline = document.createElement('input');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '100';
    this.timeline.value = '0';
    this.timeline.step = '0.01';
    this.timeline.style.cssText = 'width: 200px; cursor: pointer; margin: 0;';
    this.timeline.oninput = () => {
      const time = parseFloat(this.timeline.value);
      this.callbacks?.onSeek(time);
    };

    // Marker overlay — sits on top of the slider, pointer-events disabled
    this.markerOverlay = document.createElement('div');
    this.markerOverlay.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; overflow: hidden;
    `;

    this.timelineWrap = document.createElement('div');
    this.timelineWrap.style.cssText = 'position: relative; width: 200px; height: 20px; display: flex; align-items: center;';
    this.timelineWrap.appendChild(this.timeline);
    this.timelineWrap.appendChild(this.markerOverlay);

    // Time label
    this.timeLabel = document.createElement('span');
    this.timeLabel.textContent = '0.0 / 0.0s';
    this.timeLabel.style.cssText = 'min-width: 100px; text-align: center;';

    // Speed selector
    this.speedSelect = document.createElement('select');
    this.speedSelect.style.cssText = 'background: #222; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-family: monospace;';
    for (const speed of [0.25, 0.5, 1.0, 2.0, 4.0]) {
      const opt = document.createElement('option');
      opt.value = String(speed);
      opt.textContent = `${speed}x`;
      this.speedSelect.appendChild(opt);
    }
    this.speedSelect.value = '1';
    this.speedSelect.onchange = () => {
      this.callbacks?.onSpeedChange(parseFloat(this.speedSelect.value));
    };

    // Loop button
    this.loopBtn = document.createElement('button');
    this.loopBtn.textContent = '↻';
    this.loopBtn.style.cssText = this.btnStyle('#333');
    this.loopBtn.title = 'Loop';
    this.loopBtn.onclick = () => {
      this.callbacks?.onLoop(!this.loopBtn.classList.contains('active'));
    };

    // Save button
    this.saveBtn = document.createElement('button');
    this.saveBtn.textContent = 'Save';
    this.saveBtn.style.cssText = this.btnStyle('#2a5a2a');
    this.saveBtn.title = 'Save demo to file';
    this.saveBtn.onclick = () => this.callbacks?.onSave();

    // Load input (hidden file input)
    this.loadInput = document.createElement('input');
    this.loadInput.type = 'file';
    this.loadInput.accept = '.demo';
    this.loadInput.style.display = 'none';
    this.loadInput.onchange = () => {
      if (this.loadInput.files && this.loadInput.files[0]) {
        this.callbacks?.onLoad(this.loadInput.files[0]);
      }
    };

    // Load button (triggers file input)
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.style.cssText = this.btnStyle('#2a3a5a');
    loadBtn.title = 'Load demo from file';
    loadBtn.onclick = () => this.loadInput.click();

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
    this.container.appendChild(loadBtn);
    this.container.appendChild(this.loadInput);
    this.container.appendChild(this.statusLabel);

    document.body.appendChild(this.container);
  }

  private btnStyle(bgColor: string): string {
    return `background: ${bgColor}; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-family: monospace; font-size: 13px; min-width: 32px;`;
  }

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

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  setRecording(recording: boolean): void {
    // No-op: REC button removed from UI
  }

  setTime(current: number, duration: number): void {
    this.timeline.max = String(duration);
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

  setMarkers(hitTimes: number[], firedTimes: number[], duration: number): void {
    this.clearMarkers();
    if (duration <= 0) return;
    for (const t of hitTimes) {
      this.markerOverlay.appendChild(this.createMarker(t, duration, '#ff4444', 'rgba(255,68,68,0.8)'));
    }
    for (const t of firedTimes) {
      this.markerOverlay.appendChild(this.createMarker(t, duration, '#4488ff', 'rgba(68,136,255,0.8)'));
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
