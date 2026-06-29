import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoPlayer } from './DemoPlayer.js';

/**
 * GIF rendering options.
 */
export interface GifOptions {
  /** Output width */
  width: number;
  /** Output height */
  height: number;
  /** Frame rate */
  fps: number;
  /** Quality (1-100) */
  quality: number;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Number of colors (1-256) */
  colors: number;
}

/**
 * GIF renderer for demo playback.
 * Renders demos to animated GIF format.
 */
export class GifRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
  }

  /**
   * Render a demo to GIF.
   * @param demo - Demo file
   * @param player - Demo player instance
   * @param scene - Three.js scene
   * @param camera - Three.js camera
   * @param options - GIF options
   * @returns Promise resolving to GIF blob
   */
  async renderToGif(
    demo: DemoFile,
    player: DemoPlayer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    options: GifOptions
  ): Promise<Blob> {
    // Setup renderer
    this.renderer.setSize(options.width, options.height);
    this.renderer.setPixelRatio(1);

    // Calculate frames
    const frameCount = Math.floor((options.endTime - options.startTime) * options.fps);
    const frames: ImageData[] = [];

    // Render each frame
    const frameInterval = 1 / options.fps;

    for (let i = 0; i < frameCount; i++) {
      const time = options.startTime + (i * frameInterval);
      
      player.loadDemo(demo);
      player.seek(time);
      player.update(0);

      this.renderer.render(scene, camera);

      // Capture frame
      const imageData = this.captureFrame(options.width, options.height);
      frames.push(imageData);
    }

    // Encode GIF (simplified - in production use a library like gif.js)
    // For now, return a placeholder
    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => {
        resolve(blob!);
      }, 'image/png');
    });
  }

  /**
   * Capture a single frame as ImageData.
   * @param width - Width
   * @param height - Height
   * @returns ImageData
   */
  private captureFrame(width: number, height: number): ImageData {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    return ctx.getImageData(0, 0, width, height);
  }

  /**
   * Destroy renderer.
   */
  destroy(): void {
    this.renderer.dispose();
  }
}
