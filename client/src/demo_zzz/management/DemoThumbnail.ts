import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';

/**
 * Thumbnail generation for demo files.
 * Creates visual previews of demo playback.
 */
export class DemoThumbnail {
  /**
   * Generate a thumbnail from a demo file.
   * @param demo - Demo file
   * @param scene - Three.js scene
   * @param camera - Camera for rendering
   * @param renderer - WebGL renderer
   * @param time - Time in seconds to capture thumbnail at
   * @param width - Thumbnail width
   * @param height - Thumbnail height
   * @returns Thumbnail as data URL
   */
  static generate(
    demo: DemoFile,
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    time: number = 0,
    width: number = 320,
    height: number = 180
  ): string {
    // Find frame at specified time
    const frame = DemoThumbnail.findFrameAtTime(demo, time);
    if (!frame) {
      console.warn('[DemoThumbnail] No frame found at time', time);
      return '';
    }

    // Setup temporary render target
    const originalSize = renderer.getSize(new THREE.Vector2());
    const originalPixelRatio = renderer.getPixelRatio();

    renderer.setSize(width, height);
    renderer.setPixelRatio(1);

    // Create render target
    const renderTarget = new THREE.WebGLRenderTarget(width, height);
    renderer.setRenderTarget(renderTarget);

    // Clear and render
    renderer.clear();
    renderer.render(scene, camera);

    // Read pixels
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    // Restore renderer
    renderer.setRenderTarget(null);
    renderer.setSize(originalSize.x, originalSize.y);
    renderer.setPixelRatio(originalPixelRatio);

    renderTarget.dispose();

    // Create canvas and draw image
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return '';
    }

    // Flip Y axis (WebGL renders upside down)
    const imageData = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIndex = (y * width + x) * 4;
        const dstIndex = ((height - 1 - y) * width + x) * 4;
        imageData.data[dstIndex] = pixels[srcIndex];
        imageData.data[dstIndex + 1] = pixels[srcIndex + 1];
        imageData.data[dstIndex + 2] = pixels[srcIndex + 2];
        imageData.data[dstIndex + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Return as data URL
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  /**
   * Generate multiple thumbnails at different times.
   * @param demo - Demo file
   * @param scene - Three.js scene
   * @param camera - Camera for rendering
   * @param renderer - WebGL renderer
   * @param count - Number of thumbnails to generate
   * @param width - Thumbnail width
   * @param height - Thumbnail height
   * @returns Array of thumbnail data URLs
   */
  static generateMultiple(
    demo: DemoFile,
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    count: number = 3,
    width: number = 320,
    height: number = 180
  ): string[] {
    const thumbnails: string[] = [];
    const interval = demo.header.duration / (count + 1);

    for (let i = 1; i <= count; i++) {
      const time = interval * i;
      const thumbnail = DemoThumbnail.generate(demo, scene, camera, renderer, time, width, height);
      thumbnails.push(thumbnail);
    }

    return thumbnails;
  }

  /**
   * Generate a thumbnail strip (sprite sheet).
   * @param demo - Demo file
   * @param scene - Three.js scene
   * @param camera - Camera for rendering
   * @param renderer - WebGL renderer
   * @param count - Number of thumbnails in strip
   * @param width - Thumbnail width
   * @param height - Thumbnail height
   * @returns Thumbnail strip as data URL
   */
  static generateStrip(
    demo: DemoFile,
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    count: number = 5,
    width: number = 320,
    height: number = 180
  ): string {
    const thumbnails = DemoThumbnail.generateMultiple(demo, scene, camera, renderer, count, width, height);

    // Create strip canvas
    const stripWidth = width * count;
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width = stripWidth;
    stripCanvas.height = height;
    const ctx = stripCanvas.getContext('2d');

    if (!ctx) {
      return '';
    }

    // Draw thumbnails side by side
    for (let i = 0; i < thumbnails.length; i++) {
      const img = new Image();
      img.src = thumbnails[i];
      ctx.drawImage(img, i * width, 0, width, height);
    }

    return stripCanvas.toDataURL('image/jpeg', 0.8);
  }

  /**
   * Find frame at specific time.
   * @param demo - Demo file
   * @param time - Time in seconds
   * @returns Frame or null
   */
  private static findFrameAtTime(demo: DemoFile, time: number): DemoFrame | null {
    if (demo.frames.length === 0) {
      return null;
    }

    // Binary search for closest frame
    let left = 0;
    let right = demo.frames.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const frame = demo.frames[mid];

      if (frame.timestamp === time) {
        return frame;
      } else if (frame.timestamp < time) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // Return closest frame
    if (left >= demo.frames.length) {
      return demo.frames[demo.frames.length - 1];
    }
    if (right < 0) {
      return demo.frames[0];
    }

    const leftFrame = demo.frames[left];
    const rightFrame = demo.frames[right];

    if (Math.abs(leftFrame.timestamp - time) < Math.abs(rightFrame.timestamp - time)) {
      return leftFrame;
    } else {
      return rightFrame;
    }
  }
}
