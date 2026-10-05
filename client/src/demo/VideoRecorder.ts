// Realtime video capture of the render canvas for user-facing clip export.
// captureStream + MediaRecorder: hardware-accelerated, zero deps. Codec order
// prefers mp4 (shareable without transcoding) and falls back to webm.

const MIME_PREFERENCES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

// Staged export: the live canvas is whatever size the window happens to
// be, so the recorder blits it into a fixed 1920×1080 staging canvas —
// guaranteed aspect + resolution out of every clip. Drawing from a WebGL
// canvas reads a blank buffer unless preserveDrawingBuffer is on, unless
// the blit happens inside the same rAF the scene just rendered — the
// caller drives pump() from the render loop for that exact reason.
const STAGE_W = 1920;
const STAGE_H = 1080;

export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private stage: HTMLCanvasElement | null = null;
  private stageCtx: CanvasRenderingContext2D | null = null;
  private staged = false;
  private mime = '';

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  get isRecording(): boolean { return this.recorder !== null; }

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && Boolean(HTMLCanvasElement.prototype.captureStream);
  }

  start(fps = 60, staged = true): boolean {
    if (this.recorder || !this.canvas) {return false;}
    const mime = MIME_PREFERENCES.find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) {return false;}
    try {
      this.staged = staged;
      if (staged) {
        if (!this.stage) {
          this.stage = document.createElement('canvas');
          this.stage.width = STAGE_W;
          this.stage.height = STAGE_H;
          this.stageCtx = this.stage.getContext('2d');
        }
        this.pump();
      }
      const stream = (staged ? this.stage! : this.canvas).captureStream(fps);
      this.recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 12_000_000, // ~12 Mbps: crisp motion, sane file size
      });
    } catch {
      return false;
    }
    this.mime = mime;
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) {this.chunks.push(e.data);} };
    this.recorder.start(250); // periodic chunks so a crash keeps most of the clip
    return true;
  }

  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r) { resolve(null); return; }
      r.onstop = () => {
        const type = this.mime.split(';')[0] || 'video/webm';
        resolve(this.chunks.length > 0 ? new Blob(this.chunks, { type }) : null);
        this.chunks = [];
        this.recorder = null;
      };
      r.stop();
      this.staged = false;
    });
  }

  /** Blit the live canvas into the staging canvas — call once per rendered
   *  frame while recording staged (from the render loop, so the WebGL
   *  buffer is still live). contain-fit + black bars, same letterbox math
   *  a player expects from a 16:9 export of a non-16:9 window. */
  pump(): void {
    if (!this.staged || !this.canvas || !this.stageCtx) {return;}
    const src = this.canvas;
    const scale = Math.min(STAGE_W / src.width, STAGE_H / src.height);
    const w = src.width * scale, h = src.height * scale;
    const dx = (STAGE_W - w) / 2, dy = (STAGE_H - h) / 2;
    this.stageCtx.fillStyle = '#000';
    this.stageCtx.fillRect(0, 0, STAGE_W, STAGE_H);
    this.stageCtx.drawImage(src, 0, 0, src.width, src.height, dx, dy, w, h);
  }

  async stopAndDownload(filename = 'kribes_clip'): Promise<boolean> {
    const blob = await this.stop();
    if (!blob) {return false;}
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
}
