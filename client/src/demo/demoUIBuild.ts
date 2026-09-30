import type { DemoUI } from './DemoUI.js';

// Chrome construction: timeline slider (with the injected thumb CSS and
// the marker overlay inset to the thumb's half-width), transport/select/
// file-input controls, and the shared button style.

export function initTimeline(u: DemoUI): void {
// Timeline slider — wrapped in a relative container for marker overlay.
// The native range thumb has a half-thumb inset on each side, so the marker
// overlay must be inset to match (see THUMB_WIDTH / markerOverlay below).
const THUMB_WIDTH = 14; // px — must match the thumb size in the injected CSS
u.timeline = document.createElement('input');
u.timeline.type = 'range';
u.timeline.min = '0';
u.timeline.max = '100';
u.timeline.value = '0';
u.timeline.step = '0.01';
u.timeline.style.cssText = `
  width: 200px; cursor: pointer; margin: 0;
  -webkit-appearance: none; appearance: none;
  height: 6px; background: #333; border-radius: 3px; outline: none;
`;
u.timeline.addEventListener('input', () => {
  const time = parseFloat(u.timeline.value);
  u.callbacks?.onSeek(time);
});

// Inject thumb styling (pseudo-elements can't be set via inline styles)
if (!document.getElementById('demo-ui-slider-style')) {
  const style = document.createElement('style');
  style.id = 'demo-ui-slider-style';
  style.textContent = `
    #demo-ui input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: ${THUMB_WIDTH}px; height: ${THUMB_WIDTH}px;
      border-radius: 50%; background: #4488ff; cursor: pointer;
      border: 1px solid #2a5a9a;
    }
    #demo-ui input[type=range]::-moz-range-thumb {
      width: ${THUMB_WIDTH}px; height: ${THUMB_WIDTH}px;
      border-radius: 50%; background: #4488ff; cursor: pointer;
      border: 1px solid #2a5a9a;
    }
  `;
  document.head.appendChild(style);
}

// Marker overlay — inset by half the thumb width on each side so that
// left: pct% aligns with the thumb's center position at the same value.
u.markerOverlay = document.createElement('div');
const halfThumb = THUMB_WIDTH / 2;
u.markerOverlay.style.cssText = `
  position: absolute; top: 0; bottom: 0;
  left: ${halfThumb}px; right: ${halfThumb}px;
  pointer-events: none; overflow: hidden;
`;

u.timelineWrap = document.createElement('div');
u.timelineWrap.style.cssText = 'position: relative; width: 200px; height: 20px; display: flex; align-items: center;';
u.timelineWrap.appendChild(u.timeline);
u.timelineWrap.appendChild(u.markerOverlay);
  }

export function initControls(u: DemoUI): void {
// Speed selector
u.speedSelect = document.createElement('select');
u.speedSelect.style.cssText = 'background: #222; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-family: monospace;';
for (const speed of [0.25, 0.5, 1.0, 2.0, 4.0]) {
  const opt = document.createElement('option');
  opt.value = String(speed);
  opt.textContent = `${speed}x`;
  u.speedSelect.appendChild(opt);
}
u.speedSelect.value = '1';
u.speedSelect.addEventListener('change', () => {
  u.callbacks?.onSpeedChange(parseFloat(u.speedSelect.value));
});

// Loop button
u.loopBtn = document.createElement('button');
u.loopBtn.textContent = '↻';
u.loopBtn.style.cssText = btnStyle('#333');
u.loopBtn.title = 'Loop';
u.loopBtn.addEventListener('click', () => {
  u.callbacks?.onLoop(!u.loopBtn.classList.contains('active'));
});

// Save button
u.saveBtn = document.createElement('button');
u.saveBtn.textContent = 'Save';
u.saveBtn.style.cssText = btnStyle('#2a5a2a');
u.saveBtn.title = 'Save demo to file';
u.saveBtn.addEventListener('click', () => u.callbacks?.onSave());

// MP4 export button — records the render canvas live during playback
u.videoBtn = document.createElement('button');
u.videoBtn.textContent = 'MP4';
u.videoBtn.style.cssText = btnStyle('#5a2a2a');
u.videoBtn.title = 'Record canvas to mp4/webm while playing';
u.videoBtn.addEventListener('click', () => u.callbacks?.onVideoToggle());

// Load input (hidden file input)
u.loadInput = document.createElement('input');
u.loadInput.type = 'file';
u.loadInput.accept = '.demo';
u.loadInput.style.display = 'none';
u.loadInput.addEventListener('change', () => {
  if (u.loadInput.files && u.loadInput.files[0]) {
    u.callbacks?.onLoad(u.loadInput.files[0]);
  }
});
  }

export function btnStyle(bgColor: string): string {
    return `background: ${bgColor}; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-family: monospace; font-size: 13px; min-width: 32px;`;
  }

