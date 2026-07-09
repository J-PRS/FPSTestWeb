/**
 * Keyboard shortcuts for demo recording and playback.
 * Provides convenient key bindings for common demo operations.
 */
export class DemoControls {
  private keyBindings: Map<string, () => void> = new Map();
  private enabled: boolean = true;

  constructor() {
    this.setupDefaultBindings();
    this.attachListeners();
  }

  /**
   * Setup default key bindings.
   */
  private setupDefaultBindings(): void {
    // Recording controls
    this.bind('F5', () => this.onToggleRecording?.());
    this.bind('F6', () => this.onSaveDemo?.());
    this.bind('F7', () => this.onExtractClip?.());

    // Playback controls
    this.bind('Space', () => this.onTogglePlayback?.());
    this.bind('ArrowLeft', () => this.onSeekBackward?.());
    this.bind('ArrowRight', () => this.onSeekForward?.());
    this.bind('ArrowUp', () => this.onIncreaseSpeed?.());
    this.bind('ArrowDown', () => this.onDecreaseSpeed?.());
    this.bind('Escape', () => this.onStopPlayback?.());
    this.bind('L', () => this.onToggleLoop?.());
  }

  /**
   * Attach keyboard event listeners.
   */
  private attachListeners(): void {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  /**
   * Handle keyboard events.
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) {
      return;
    }

    // Don't trigger if user is typing in an input field
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    const key = this.getKeyString(event);
    const callback = this.keyBindings.get(key);

    if (callback) {
      event.preventDefault();
      callback();
    }
  }

  /**
   * Get key string from keyboard event.
   */
  private getKeyString(event: KeyboardEvent): string {
    let key = event.key;

    // Handle special keys
    if (key === ' ') {
      key = 'Space';
    }

    // Handle modifiers
    if (event.ctrlKey) {
      key = 'Ctrl+' + key;
    }
    if (event.shiftKey) {
      key = 'Shift+' + key;
    }
    if (event.altKey) {
      key = 'Alt+' + key;
    }

    return key;
  }

  /**
   * Bind a key to a callback.
   * @param key - Key string (e.g., 'F5', 'Space', 'Ctrl+S')
   * @param callback - Function to call when key is pressed
   */
  bind(key: string, callback: () => void): void {
    this.keyBindings.set(key, callback);
  }

  /**
   * Unbind a key.
   * @param key - Key string to unbind
   */
  unbind(key: string): void {
    this.keyBindings.delete(key);
  }

  /**
   * Clear all key bindings.
   */
  clearBindings(): void {
    this.keyBindings.clear();
  }

  /**
   * Enable or disable controls.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if controls are enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get all bound keys.
   */
  getBoundKeys(): string[] {
    return Array.from(this.keyBindings.keys());
  }

  // Callbacks (to be set by the application)
  onToggleRecording?: () => void;
  onSaveDemo?: () => void;
  onExtractClip?: () => void;
  onTogglePlayback?: () => void;
  onSeekBackward?: () => void;
  onSeekForward?: () => void;
  onIncreaseSpeed?: () => void;
  onDecreaseSpeed?: () => void;
  onStopPlayback?: () => void;
  onToggleLoop?: () => void;

  /**
   * Destroy controls and remove listeners.
   */
  destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown.bind(this));
    this.keyBindings.clear();
  }
}

/**
 * Default key bindings reference.
 */
export const DEFAULT_KEY_BINDINGS = {
  // Recording
  TOGGLE_RECORDING: 'F5',
  SAVE_DEMO: 'F6',
  EXTRACT_CLIP: 'F7',

  // Playback
  TOGGLE_PLAYBACK: 'Space',
  SEEK_BACKWARD: 'ArrowLeft',
  SEEK_FORWARD: 'ArrowRight',
  INCREASE_SPEED: 'ArrowUp',
  DECREASE_SPEED: 'ArrowDown',
  STOP_PLAYBACK: 'Escape',
  TOGGLE_LOOP: 'L',
} as const;
