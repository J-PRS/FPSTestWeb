// Realtime video capture of the render canvas for user-facing clip export.
// captureStream + MediaRecorder: hardware-accelerated, zero deps. Codec order
// prefers mp4 (shareable without transcoding) and falls back to webm.

const MIME_PREFERENCES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private mime = '';

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  get isRecording(): boolean { return this.recorder !== null; }

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && Boolean(HTMLCanvasElement.prototype.captureStream);
  }

  start(fps = 60): boolean {
    if (this.recorder || !this.canvas) {return false;}
    const mime = MIME_PREFERENCES.find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) {return false;}
    try {
      const stream = this.canvas.captureStream(fps);
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
    });
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
