import * as THREE from 'three';

// Warm the Rajdhani face early — canvas text uses whatever's loaded at
// draw time, so without this the first few hits stamp in the fallback
void document.fonts?.load('700 56px Rajdhani');

export class DamageNumber {
  private sprite: THREE.Sprite;
  private material: THREE.SpriteMaterial;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  age = 0; // public: manager reads it for the merge window
  private dead = false;
  private readonly duration = 1.0; // seconds
  private readonly popScale = 0.1; // Initial pop scale
  private readonly baseScale = 4.0; // sprite scale — distScale adds range scaling
  private distScale = 1; // Distance-based scale factor
  private dmgScale = 1; // Damage-magnitude scale — big hits deserve big numbers
  private damage = 0;
  private color = '#ffffff';
  // Velocity-based drift: bursts up+sideways, gravity settles it — the
  // ease-out arc reads intentional where a straight linear rise reads cheap
  private vel = new THREE.Vector3();
  readonly anchor = new THREE.Vector3(); // for manager-side merging

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
    this.damage = damage;
    this.color = color;
    let distScale = 1.0;
    if (camera) {
      const dist = camera.position.distanceTo(pos);
      // sqrt distance scaling — constant-screen-size (linear ∝ dist) makes
      // far numbers comically huge; sqrt keeps far hits readable while near
      // hits stay crisp. 1.0 at the ~15m reference range.
      distScale = Math.max(0.45, Math.min(3.0, Math.sqrt(dist / 15)));
    }
    this.distScale = distScale;
    // sqrt scaling: a 4× hit reads ~1.5× bigger, not 4× — weight without
    // letting a crit number swallow the screen
    this.dmgScale = Math.min(1.6, 1 + Math.sqrt(Math.max(0, damage)) * 0.05);

    this.redraw();

    // Toss it up and slightly off-axis — the gravity settle does the easing
    this.sprite.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 1.0, pos.z + (Math.random() - 0.5) * 0.4);
    this.anchor.copy(this.sprite.position);
    this.vel.set((Math.random() - 0.5) * 1.6, 3.2 + Math.random() * 0.8, (Math.random() - 0.5) * 1.6);

    const s = this.baseScale * distScale * this.dmgScale * this.popScale;
    this.sprite.scale.set(s, s / 2, s / 2);
    this.sprite.visible = true;
    this.material.opacity = 1.0;
    this.age = 0;
    this.dead = false;
  }

  /** Merge another hit into this number (rapid-fire aggregation). Refreshes
   *  life and pops slightly — Borderlands-style running total per target. */
  merge(extra: number): void {
    this.damage += extra;
    this.dmgScale = Math.min(1.6, 1 + Math.sqrt(Math.max(0, this.damage)) * 0.05);
    this.redraw();
    this.age = Math.min(this.age, this.duration * 0.3); // partial refresh
    this.vel.y = Math.max(this.vel.y, 1.6); // little hop so the merge reads
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Rajdhani Bold — condensed squared sci-fi digits, the shooter FCT
    // font. Falls back to heavy Segoe if the woff hasn't loaded yet.
    ctx.font = `700 56px "Rajdhani", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    const text = Math.round(this.damage).toString();
    ctx.strokeText(text, this.canvas.width / 2, this.canvas.height / 2);
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    this.texture.needsUpdate = true;
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
      const s = this.baseScale * this.distScale * this.dmgScale * popScale;
      this.sprite.scale.set(s, s / 2, s / 2);
    }

    // Ballistic drift — up fast, gravity eases it to a stop
    this.vel.y -= 5.5 * dt;
    if (this.vel.y < 0) this.vel.y *= 0.9; // hover briefly at the top
    this.sprite.position.addScaledVector(this.vel, dt);

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

  private mergeRadiusSq = 1.2 * 1.2; // same target, roughly
  private mergeWindow = 0.35; // seconds — rapid hits fold into one number

  spawn(pos: THREE.Vector3, damage: number, color?: string, camera?: THREE.Camera): void {
    // Rapid hits on the same spot aggregate into a running total instead of
    // a shotgun spray of overlapping numbers (chaingun/flak feel)
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      if (n.age < this.mergeWindow && n.anchor.distanceToSquared(pos) < this.mergeRadiusSq) {
        n.merge(damage);
        return;
      }
    }
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
