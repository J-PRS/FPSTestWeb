import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoPlayer } from './DemoPlayer.js';

/**
 * Rendering options.
 */
export interface RenderOptions {
  /** Output resolution width */
  width: number;
  /** Output resolution height */
  height: number;
  /** Frame rate */
  fps: number;
  /** Quality (1-100) */
  quality: number;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Whether to include audio */
  includeAudio: boolean;
}

/**
 * Demo video renderer.
 * Renders demo playback to video files.
 */
export class DemoRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
  }

  /**
   * Render a demo to video.
   * @param demo - Demo file
   * @param player - Demo player instance
   * @param scene - Three.js scene
   * @param camera - Three.js camera
   * @param options - Rendering options
   * @returns Promise resolving to video blob
   */
  async renderToVideo(
    demo: DemoFile,
    player: DemoPlayer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    options: RenderOptions
  ): Promise<Blob> {
    // Setup renderer
    this.renderer.setSize(options.width, options.height);
    this.renderer.setPixelRatio(1);

    // Setup media recorder
    const stream = this.canvas.captureStream(options.fps);
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: options.quality * 100000,
    });

    this.recordedChunks = [];
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    // Start recording
    this.mediaRecorder.start();

    // Load and play demo
    player.loadDemo(demo);
    player.seek(options.startTime);
    player.play();

    // Render frames
    const frameInterval = 1000 / options.fps;
    let lastFrameTime = 0;
    let currentTime = options.startTime;

    const renderLoop = (timestamp: number) => {
      if (currentTime >= options.endTime) {
        player.stop();
        this.mediaRecorder?.stop();
        return;
      }

      if (timestamp - lastFrameTime >= frameInterval) {
        this.renderer.render(scene, camera);
        lastFrameTime = timestamp;
        currentTime += 1 / options.fps;
      }

      requestAnimationFrame(renderLoop);
    };

    requestAnimationFrame(renderLoop);

    // Wait for recording to complete
    return new Promise((resolve) => {
      this.mediaRecorder!.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        resolve(blob);
      };
    });
  }

  /**
   * Render a single frame to image.
   * @param demo - Demo file
   * @param player - Demo player instance
   * @param scene - Three.js scene
   * @param camera - Three.js camera
   * @param time - Time to capture
   * @param width - Image width
   * @param height - Image height
   * @returns Promise resolving to image blob
   */
  async renderFrame(
    demo: DemoFile,
    player: DemoPlayer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    time: number,
    width: number = 1920,
    height: number = 1080
  ): Promise<Blob> {
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1);

    player.loadDemo(demo);
    player.seek(time);
    player.update(0);

    this.renderer.render(scene, camera);

    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => {
        resolve(blob!);
      }, 'image/png');
    });
  }

  /**
   * Render a thumbnail strip.
   * @param demo - Demo file
   * @param player - Demo player instance
   * @param scene - Three.js scene
   * @param camera - Three.js camera
   * @param count - Number of thumbnails
   * @param width - Thumbnail width
   * @param height - Thumbnail height
   * @returns Promise resolving to image blob
   */
  async renderThumbnailStrip(
    demo: DemoFile,
    player: DemoPlayer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    count: number = 5,
    width: number = 320,
    height: number = 180
  ): Promise<Blob> {
    const stripWidth = width * count;
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width = stripWidth;
    stripCanvas.height = height;
    const ctx = stripCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    const interval = demo.header.duration / (count + 1);

    for (let i = 0; i < count; i++) {
      const time = interval * (i + 1);
      const thumbnail = await this.renderFrame(demo, player, scene, camera, time, width, height);
      const img = await this.blobToImage(thumbnail);
      ctx.drawImage(img, i * width, 0, width, height);
    }

    return new Promise((resolve) => {
      stripCanvas.toBlob((blob) => {
        resolve(blob!);
      }, 'image/jpeg', 0.8);
    });
  }

  /**
   * Convert blob to image.
   * @param blob - Image blob
   * @returns Promise resolving to HTMLImageElement
   */
  private blobToImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  /**
   * Destroy renderer.
   */
  destroy(): void {
    this.renderer.dispose();
    this.mediaRecorder?.stop();
  }
}
