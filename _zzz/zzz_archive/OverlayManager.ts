import { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';

interface OverlayManagerDependencies {
  renderer: { domElement: HTMLElement };
  demoManager: DemoManager | null;
  logger: ChildLogger;
}

export class OverlayManager {
  private overlay: HTMLElement;
  private rendererDomElement: HTMLElement;
  private demoManager: DemoManager | null;
  private logger: ChildLogger;
  private gameStarted: boolean = false;
  private unlockByEscape: boolean = false;

  constructor(dependencies: OverlayManagerDependencies) {
    this.overlay = document.getElementById('overlay')!;
    this.rendererDomElement = dependencies.renderer.domElement;
    this.demoManager = dependencies.demoManager;
    this.logger = dependencies.logger;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange());
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.getElementById('start-btn')!.addEventListener('click', () => this.onStartBtnClick());
    this.rendererDomElement.addEventListener('click', () => this.onRendererClick());
  }

  private onPointerLockChange(): void {
    this.logger.debug(`Pointer lock changed: locked=${document.pointerLockElement === this.rendererDomElement}`);
    if (document.pointerLockElement === this.rendererDomElement) {
      this.overlay.style.display = 'none';
      this.unlockByEscape = false;
    } else if (this.gameStarted && this.unlockByEscape) {
      this.overlay.style.display = 'flex';
      this.demoManager?.onCoolShotsChanged?.(this.demoManager.getCoolShots());
      this.demoManager?.fetchCoolShotsFromServer();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // During demo playback, only allow ESC, F6, and arrow keys
    if (this.demoManager?.isPlaying && e.code !== 'Escape' && e.code !== 'F6' &&
        e.code !== 'ArrowUp' && e.code !== 'ArrowDown' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') {
      return;
    }

    // Demo playback shortcuts
    if (this.demoManager?.isPlaying) {
      if (e.code === 'ArrowUp') {
        e.preventDefault();
        this.demoManager.togglePlayPause();
        return;
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        this.demoManager.restart();
        return;
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.demoManager.seekBy(-2);
        return;
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.demoManager.seekBy(2);
        return;
      }
    }

    if (e.code === 'Escape' && this.gameStarted) {
      this.handleEscape();
    }
    if (e.code === 'F6') {
      if (this.demoManager) this.demoManager.toggleUI();
    }
    if (e.code === 'Space' && this.demoManager?.isLoadedForPlayback) {
      e.preventDefault();
      this.demoManager.togglePlayPause();
      return;
    }
  }

  private handleEscape(): void {
    // If demo is playing, stop it entirely
    if (this.demoManager?.isPlaying) {
      this.demoManager.stopPlayback();
      return;
    }
    if (document.pointerLockElement === this.rendererDomElement) {
      this.unlockByEscape = true;
      document.exitPointerLock();
      this.overlay.style.display = 'flex';
      this.demoManager?.onCoolShotsChanged?.(this.demoManager.getCoolShots());
      this.demoManager?.fetchCoolShotsFromServer();
    } else if (this.overlay.style.display === 'flex' && document.pointerLockElement !== this.rendererDomElement) {
      this.overlay.style.display = 'none';
      this.logger.debug('Requesting pointer lock...');
      this.requestLock();
    } else if (document.pointerLockElement !== this.rendererDomElement) {
      this.overlay.style.display = 'flex';
    }
  }

  private onStartBtnClick(): void {
    if (this.demoManager?.isPlaying) { this.demoManager.stopPlayback(); return; }
    this.requestLock();
  }

  private onRendererClick(): void {
    if (this.demoManager?.isPlaying) return;
    if (document.pointerLockElement !== this.rendererDomElement) this.requestLock();
  }

  private requestLock(): void {
    this.rendererDomElement.requestPointerLock();
  }

  setGameStarted(started: boolean): void {
    this.gameStarted = started;
  }

  showOverlay(): void {
    this.overlay.style.display = 'flex';
  }

  hideOverlay(): void {
    this.overlay.style.display = 'none';
  }
}
