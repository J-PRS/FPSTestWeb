// Mock Sprunk Engine implementation
// This is a simplified mock to allow the project to run

export class Vector3 {
  constructor(public x: number = 0, public y: number = 0, public z: number = 0) {}
  
  set(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  
  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }
  
  multiplyScalar(scalar: number): Vector3 {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }
  
  add(vector: Vector3): Vector3 {
    this.x += vector.x;
    this.y += vector.y;
    this.z += vector.z;
    return this;
  }
  
  applyAxisAngle(axis: Vector3, angle: number): Vector3 {
    // Simplified rotation around Y axis
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = this.x * cos - this.z * sin;
    const z = this.x * sin + this.z * cos;
    this.x = x;
    this.z = z;
    return this;
  }
  
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  
  normalize(): Vector3 {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
      this.z /= len;
    }
    return this;
  }
}

export class Engine {
  private canvas: HTMLCanvasElement;
  private webgpu: boolean;
  private running: boolean = false;
  private callbacks: Map<string, Function[]> = new Map();
  private lastTime: number = 0;
  private gl: WebGLRenderingContext | null = null;

  constructor(options: { canvas: HTMLCanvasElement; webgpu: boolean }) {
    this.canvas = options.canvas;
    this.webgpu = options.webgpu;
    
    // Setup canvas
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    
    // Initialize WebGL
    this.gl = this.canvas.getContext('webgl2') || this.canvas.getContext('webgl') as WebGLRenderingContext;
    
    if (this.gl) {
      this.gl.clearColor(0.1, 0.1, 0.15, 1.0);
      this.gl.enable(this.gl.DEPTH_TEST);
    }
    
    // Handle resize
    window.addEventListener('resize', () => {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
      if (this.gl) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
    });
    
    // Check WebGPU support
    if (this.webgpu && !navigator.gpu) {
      console.warn('WebGPU not supported, falling back to WebGL');
    }
  }

  on(event: string, callback: Function): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, []);
    }
    this.callbacks.get(event)!.push(callback);
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    this.gameLoop();
  }

  private gameLoop(): void {
    if (!this.running) return;
    
    const currentTime = performance.now();
    const deltaTime = (currentTime - this.lastTime) / 1000;
    this.lastTime = currentTime;
    
    // Clear and render
    if (this.gl) {
      this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    }
    
    const updateCallbacks = this.callbacks.get('update') || [];
    updateCallbacks.forEach(callback => callback(deltaTime));
    
    requestAnimationFrame(() => this.gameLoop());
  }
}

export class Scene {
  constructor(private engine: Engine) {}
}

export class Camera {
  position: Vector3 = new Vector3(0, 2, 5);
  rotation: Vector3 = new Vector3(0, 0, 0);
  
  constructor(private scene: Scene) {}
  
  getForward(): Vector3 {
    const forward = new Vector3(0, 0, -1);
    forward.applyAxisAngle(new Vector3(0, 1, 0), this.rotation.y);
    return forward;
  }
  
  getRight(): Vector3 {
    const right = new Vector3(1, 0, 0);
    right.applyAxisAngle(new Vector3(0, 1, 0), this.rotation.y);
    return right;
  }
  
  getUp(): Vector3 {
    return new Vector3(0, 1, 0);
  }
}

export class Input {
  private keys: Map<string, boolean> = new Map();
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  private lastMousePosition: { x: number; y: number } = { x: 0, y: 0 };

  constructor(private engine: Engine) {
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      this.keys.set(e.code, true);
    });
    
    window.addEventListener('keyup', (e) => {
      this.keys.set(e.code, false);
    });
    
    // Mouse events
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === document.body) {
        this.mouseDelta.x = e.movementX;
        this.mouseDelta.y = e.movementY;
      }
    });
  }

  lockPointer(): void {
    document.body.requestPointerLock();
  }

  isKeyDown(code: string): boolean {
    return this.keys.get(code) || false;
  }

  getMouseDelta(): { x: number; y: number } {
    const delta = { ...this.mouseDelta };
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    return delta;
  }
}

export class Material {
  constructor(private scene: Scene, options: { color: number; wireframe?: boolean }) {
    // Material setup
  }
}

export class Mesh {
  position: Vector3 = new Vector3(0, 0, 0);
  rotation: Vector3 = new Vector3(0, 0, 0);
  scale: Vector3 = new Vector3(1, 1, 1);
  
  constructor(
    private scene: Scene,
    options: { geometry: string; material: Material }
  ) {
    // Mesh setup
  }
}
