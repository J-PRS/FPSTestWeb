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
  private timeLabel: HTMLSpanElement;
  private playBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private speedSelect: HTMLSelectElement;
  private loopBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private loadInput: HTMLInputElement;
  private recordBtn: HTMLButtonElement;
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

    // Record button
    this.recordBtn = document.createElement('button');
    this.recordBtn.textContent = 'REC';
    this.recordBtn.style.cssText = this.btnStyle('#cc3333');
    this.recordBtn.title = 'Toggle recording';
    this.recordBtn.onclick = () => this.callbacks?.onRecordToggle();

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

    // Timeline slider
    this.timeline = document.createElement('input');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '100';
    this.timeline.value = '0';
    this.timeline.step = '0.01';
    this.timeline.style.cssText = 'width: 200px; cursor: pointer;';
    this.timeline.oninput = () => {
      const time = parseFloat(this.timeline.value);
      this.callbacks?.onSeek(time);
    };

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
    this.container.appendChild(this.recordBtn);
    this.container.appendChild(this.playBtn);
    this.container.appendChild(this.stopBtn);
    this.container.appendChild(this.timeline);
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

  get isVisible(): boolean { return this.visible; }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  setRecording(recording: boolean): void {
    this.recordBtn.style.background = recording ? '#ff3333' : '#cc3333';
    this.recordBtn.style.color = recording ? '#fff' : '#aaa';
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
}
