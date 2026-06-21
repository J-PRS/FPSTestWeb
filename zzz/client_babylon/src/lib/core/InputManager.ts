export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  shoot: boolean;
  sprint: boolean;
  crouch: boolean;
  reload: boolean;
  menu: boolean;
  mouseDeltaX: number;
  mouseDeltaY: number;
  jetpack: boolean;
}

export class InputManager {
  private state: InputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    shoot: false,
    sprint: false,
    crouch: false,
    reload: false,
    menu: false,
    mouseDeltaX: 0,
    mouseDeltaY: 0,
    jetpack: false
  };

  private keys = new Map<string, Exclude<keyof InputState, 'mouseDeltaX' | 'mouseDeltaY'>>();
  private mousePosition = { x: 0, y: 0 };
  private mouseDelta = { x: 0, y: 0 };
  private isPointerLocked = false;
  private eventHandlers = new Map<string, Set<(data?: any) => void>>();

  constructor() {
    this.setupKeyBindings();
  }

  private setupKeyBindings(): void {
    // WASD movement
    this.keys.set('KeyW', 'forward');
    this.keys.set('KeyS', 'backward');
    this.keys.set('KeyA', 'left');
    this.keys.set('KeyD', 'right');

    // Actions
    this.keys.set('Space', 'jump');
    this.keys.set('ShiftLeft', 'sprint');
    this.keys.set('ControlLeft', 'crouch');
    this.keys.set('KeyR', 'reload');
    this.keys.set('Escape', 'menu');
  }

  onKeyDown(event: KeyboardEvent): void {
    const action = this.keys.get(event.code);
    if (action) {
      this.state[action] = true;
      this.emit(action, true);
      event.preventDefault();
    }
  }

  onKeyUp(event: KeyboardEvent): void {
    const action = this.keys.get(event.code);
    if (action) {
      this.state[action] = false;
      this.emit(action, false);
      event.preventDefault();
    }
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button === 0) { // Left click
      this.state.shoot = true;
      this.emit('shoot', true);
      event.preventDefault();
    } else if (event.button === 2) { // Right click
      this.state.jetpack = true;
      this.emit('jetpack', true);
      event.preventDefault();
    }
  }

  onMouseUp(event: MouseEvent): void {
    if (event.button === 0) { // Left click
      this.state.shoot = false;
      this.emit('shoot', false);
      event.preventDefault();
    } else if (event.button === 2) { // Right click
      this.state.jetpack = false;
      this.emit('jetpack', false);
      event.preventDefault();
    }
  }

  on(event: string, handler: (data?: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: (data?: any) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    }
  }

  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in input event handler for "${event}":`, error);
        }
      });
    }
  }

  onMouseMove(event: MouseEvent): void {
    if (this.isPointerLocked) {
      // Accumulate mouse delta (don't reset - browser already time-normalizes)
      this.mouseDelta.x += event.movementX;
      this.mouseDelta.y += event.movementY;
      this.state.mouseDeltaX += event.movementX;
      this.state.mouseDeltaY += event.movementY;
    }
    this.mousePosition.x = event.clientX;
    this.mousePosition.y = event.clientY;
  }

  onPointerLockChange(): void {
    this.isPointerLocked = document.pointerLockElement !== null;
  }

  getState(): InputState {
    const state = { ...this.state };
    // Reset mouse delta after reading (consumed by player controller)
    this.state.mouseDeltaX = 0;
    this.state.mouseDeltaY = 0;
    return state;
  }

  getMouseDelta(): { x: number; y: number } {
    const delta = { ...this.mouseDelta };
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    return delta;
  }

  getMousePosition(): { x: number; y: number } {
    return { ...this.mousePosition };
  }

  isPointerLockedActive(): boolean {
    return this.isPointerLocked;
  }

  reset(): void {
    this.state.forward = false;
    this.state.backward = false;
    this.state.left = false;
    this.state.right = false;
    this.state.jump = false;
    this.state.shoot = false;
    this.state.sprint = false;
    this.state.crouch = false;
    this.state.reload = false;
    this.state.menu = false;
    this.state.mouseDeltaX = 0;
    this.state.mouseDeltaY = 0;
    this.state.jetpack = false;
    this.mouseDelta = { x: 0, y: 0 };
  }

  dispose(): void {
    this.reset();
    this.keys.clear();
    this.eventHandlers.clear();
  }
}
