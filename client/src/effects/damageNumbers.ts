import * as THREE from 'three';

export class DamageNumber {
  private sprite: THREE.Sprite;
  private material: THREE.SpriteMaterial;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private age = 0;
  private dead = false;
  private readonly duration = 1.0; // seconds
  private readonly floatHeight = 2.0; // units to float upward
  private readonly popScale = 0.1; // Initial pop scale
  private readonly baseScale = 8; // Base scale factor
  private distScale = 1; // Distance-based scale factor
  private _startY = 0;

  constructor(scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.width = 192;
    this.canvas.height = 96;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 1.0,
    });
    this.sprite = new THREE.Sprite(this.material);
    scene.add(this.sprite);
  }

  /** Reuse the sprite/canvas/texture for a new number — zero GPU alloc. */
  reset(pos: THREE.Vector3, damage: number, color: string = '#ffffff', camera?: THREE.Camera): void {
    this._startY = pos.y + 1.0;
    let distScale = 1.0;
    if (camera) {
      const dist = camera.position.distanceTo(pos);
      distScale = Math.max(0.4, Math.min(1.5, 2.5 / Math.sqrt(dist)));
    }
    this.distScale = distScale;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = `bold 48px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    const text = Math.round(damage).toString();
    ctx.strokeText(text, this.canvas.width / 2, this.canvas.height / 2);
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    this.texture.needsUpdate = true;

    const spreadX = (Math.random() - 0.5) * 1.5;
    const spreadZ = (Math.random() - 0.5) * 1.5;
    this.sprite.position.set(pos.x + spreadX, this._startY, pos.z + spreadZ);
    this.sprite.scale.set(
      this.baseScale * distScale * this.popScale,
      (this.baseScale / 2) * distScale * this.popScale,
      (this.baseScale / 2) * distScale * this.popScale,
    );
    this.sprite.visible = true;
    this.material.opacity = 1.0;
    this.age = 0;
    this.dead = false;
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age >= this.duration) {
      this.dead = true;
      return;
    }

    const t = this.age / this.duration;

    // Pop animation: quick scale up in first 0.1s
    if (t < 0.125) {
      const popT = t / 0.125;
      const popScale = this.popScale + (1 - this.popScale) * popT;
      this.sprite.scale.set(this.baseScale * this.distScale * popScale, (this.baseScale / 2) * this.distScale * popScale, (this.baseScale / 2) * this.distScale * popScale);
    }

    // Float upward
    this.sprite.position.y = this._startY + t * this.floatHeight;

    // Fade out (stay visible longer, fade quickly at end)
    if (t > 0.6) {
      this.material.opacity = 1 - ((t - 0.6) / 0.4);
    }
  }

  /** Detach from scene but keep resources for pooling. */
  deactivate(): void {
    this.sprite.visible = false;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
  }

  get isDead(): boolean {
    return this.dead;
  }
}

export class DamageNumberManager {
  private numbers: DamageNumber[] = [];
  private pool: DamageNumber[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawn(pos: THREE.Vector3, damage: number, color?: string, camera?: THREE.Camera): void {
    const num = this.pool.pop() ?? new DamageNumber(this.scene);
    num.reset(pos, damage, color, camera);
    this.numbers.push(num);
  }

  update(dt: number): void {
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const num = this.numbers[i];
      num.update(dt);
      if (num.isDead) {
        num.deactivate(); // pooled — sprite stays in scene hidden
        this.pool.push(num);
        this.numbers.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const num of this.numbers) num.dispose();
    for (const num of this.pool) num.dispose();
    this.numbers = [];
    this.pool = [];
  }
}
