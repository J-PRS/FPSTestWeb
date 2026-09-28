import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import { bakeVertexAO } from '../effects/vertexAO.js';
import { urlParams } from '../core/params.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildWeaponMeshes, buildHandAndFlash, FIST_JAB, FIST_OFF } from './viewmodel/weaponsGeo.js';
import { makeShieldMaterial } from '../effects/shieldBubble.js';

// Port of Assets/Scripts/WeaponSway.cs (Unity FPS_Test) — mouse-lag sway,
// velocity offset, perlin-ish bob, and landing dip.
const SWAY_AMOUNT = 0.02;
const SWAY_MAX = 0.03;
const VEL_AMOUNT = 0.004;
const VEL_MAX = 0.04;
const BOB_SPEED = 4;
const BOB_HEIGHT = 0.006;
const FALL_THRESHOLD = 10;
const FALL_MULT = 0.004;
const FALL_MAX = 0.08;

const REST_POS = new THREE.Vector3(0.25, -0.28, -0.45);

// Belt-item throw (Tribes-style build up): weapon dips, item releases
// mid-animation, weapon raises back. THROW_RELEASE is when the
// projectile should actually spawn.
export const THROW_RELEASE = 0.7; // Tribes Ascend belt-item build-up time
const THROW_LOWER_TIME = 0.18;
const THROW_RAISE_TIME = 0.25;
// Total throw cycle — Player gates primary fire on this: the gun is
// physically lowered, shooting mid-throw means firing through the hip.
export const THROW_TOTAL = THROW_RELEASE + THROW_RAISE_TIME + 0.05;
const THROW_DIP_Y = -0.22;
const THROW_DIP_Z = 0.06;
const THROW_DIP_ROT = -0.12; // slight muzzle-down tilt, gun stays level-ish
const THROW_DIP_ROLL = 0.18; // rolls outward, weapon tips to the right

// Weapon switch: quick lower, swap model at the bottom, raise back up
const SWITCH_LOWER_TIME = 0.12;
const SWITCH_RAISE_TIME = 0.16;
// Sidearm hold-out gates its fire on the raise completing — a "pull it out
// and it's live" beat, same window the viewmodel spends drawing the gun.
export const SIDEARM_DRAW_TIME = SWITCH_LOWER_TIME + SWITCH_RAISE_TIME;
const SWITCH_DIP_Y = -0.34;
const SWITCH_DIP_ROT = -0.35; // muzzle tips down as it holsters

// Melee punch: CoD-style — the weapon drops low/right like holstering while
// an off-hand fist jabs in from bottom-left. Fast in, impact hold, spring back.
const PUNCH_IN = 0.09;
const PUNCH_HOLD = 0.08;
const PUNCH_OUT = 0.32;
const PUNCH_TOTAL = PUNCH_IN + PUNCH_HOLD + PUNCH_OUT;
const PUNCH_X = 0.18;    // gun swings right
const PUNCH_Y = -0.3;    // and deep — nearly holstered, not a recoil
const PUNCH_Z = 0.06;
const PUNCH_ROLL = 0.5;
const PUNCH_ROT = -0.35; // muzzle tips DOWN (negative like switch) — butt-up sweep, never recoil-up

export class ViewModel {
  readonly group: THREE.Group;
  // Keyed by WeaponType — the array order used to collide with the enum
  // (Chaingun=3 showed the mortar mesh, Railgun=9 indexed past the end).
  private weapons = new Map<number, THREE.Group>();
  // Empty node parked at each weapon's muzzle — world position IS the
  // attachment point for beam VFX, so the bolt tracks sway/kick exactly.
  private muzzleNodes = new Map<number, THREE.Object3D>();
  // Muzzle Z per weapon (model space) so the flash sits AT the bore,
  // not at a fixed offset that floats ahead of stubby barrels.
  private static readonly MUZZLE_Z: Record<number, number> = {
    [WeaponType.Rocket]: -0.44, [WeaponType.Disc]: -0.46, [WeaponType.DiscPull]: -0.46, // just past the fork's prong tips
    [WeaponType.Chaingun]: -0.55, // just past the barrel cluster tips [WeaponType.Mortar]: -0.28, [WeaponType.GrenadeLauncher]: -0.42,
    [WeaponType.Flak]: -0.28, [WeaponType.PlasmaCannon]: -0.28, [WeaponType.PlasmaGun]: -0.26,
    [WeaponType.Railgun]: -0.43,
    [WeaponType.Shotgun]: -0.41, [WeaponType.Cannon]: -0.53,
    [WeaponType.RocketLauncher]: -0.44, // just past the warhead tip
    [WeaponType.Lightning]: -0.42, // emitter ball at the prong tips
    [WeaponType.Sticky]: -0.40,
  };
  private chainBarrels: THREE.Group | null = null;
  private spinVel = 0;
  private static readonly SPIN_MAX = 40; // rad/s at full spin
  private activeWeapon = 0;
  private switchT = -1;
  private pendingWeapon = -1;
  private timer = 0;
  private kickAmount = 0;
  private kickVel = 0;       // spring velocity — impulse IN, overshoot settle
  private kickX = 0;         // sideways kick — flak/melee shudder
  private kickRoll = 0;      // per-shot roll — alternating twist reads as torque
  private kickDecay = 12;    // per-weapon spring rate
  private flashLifeScale = 1;
  private throwT = -1;
  private punchT = -1;
  private fistGroup: THREE.Group;
  private baseRotX = 0.04;
  private baseRotZ = 0;
  private flashMesh: THREE.Mesh;
  private flashMesh2: THREE.Mesh;
  private flashMat: THREE.MeshBasicMaterial;
  private flashT = 0;
  private static readonly FLASH_LIFE = 0.07; // 1-2 frames feel; >0.15 reads as flamethrower
  private lastFrameYVel = 0;
  private lastFrameVel = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();

  private readonly vmCam: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.vmCam = camera;
    this.group = new THREE.Group();

    const built = buildWeaponMeshes(this.group, ViewModel.MUZZLE_Z);
    this.weapons = built.weapons;
    this.muzzleNodes = built.muzzleNodes;
    this.chainBarrels = built.chainBarrels;
    // Bake vertex AO once — darkens bore interiors, part joints, crevices.
    // Primitives have no UVs so this replaces texture AO entirely.
    for (const g of this.weapons.values()) bakeVertexAO(g);
    this.loadBakedWeapons();

    const hf = buildHandAndFlash(this.group);
    this.fistGroup = hf.fistGroup;
    this.flashMat = hf.flashMat;
    this.flashMesh = hf.flashMesh;
    this.flashMesh2 = hf.flashMesh2;

    // Bottom-right, mostly centered — Quake guns sit low and fat
    this.group.scale.setScalar(0.8);
    this.group.position.copy(REST_POS);
    this.group.rotation.y = 0.05;
    this.group.rotation.x = this.baseRotX;

    camera.add(this.group);
  }

  // Camera-space muzzle offset for an ARBITRARY weapon — same math as
  // getMuzzleOffset but not tied to whichever weapon is active (the beam
  // keeps welding to the LG emitter during the holster dip).
  muzzleViewPos(wt: number, out: THREE.Vector3): boolean {
    const n = this.muzzleNodes.get(wt);
    if (!n) return false;
    n.getWorldPosition(out);
    this.vmCam.worldToLocal(out);
    return true;
  }

  // World-space point where a muzzle node actually RENDERS on screen.
  // The gun draws through vmCam (FOV 55) while the world renders through
  // the main camera (FOV 90) — a raw camera-space offset lands on the
  // wrong ray, which is why the beam visibly detached from the gun tip.
  // Project through vmCam to NDC (the pixel the emitter occupies), then
  // unproject through the main camera → a world point on the main cam's
  // ray through that exact pixel. Anchor and emitter can never disagree.
  muzzleAnchorWorld(wt: number, cam: THREE.Camera, out: THREE.Vector3): boolean {
    // vmCam's quaternion is only synced inside renderFrame — mid-update it
    // still holds LAST frame's rotation, so fast turns leave the anchor a
    // frame behind the rendered gun. Sync it here to this frame's truth.
    this.vmCam.quaternion.copy(cam.quaternion);
    this.vmCam.updateMatrixWorld();
    if (!this.muzzleViewPos(wt, out)) return false;
    out.applyMatrix4(this.vmCam.projectionMatrix); // view space → NDC
    cam.updateMatrixWorld();
    out.unproject(cam); // NDC → world along the main camera's ray
    return true;
  }

  // Swap procedural meshes for Blender-baked GLB+AO when the assets exist
  // (tools/vmdump pipeline). Keeps glow parts procedural; falls back silently.
  private async loadBakedWeapons(): Promise<void> {
    // Export mode must serialize the PROCEDURAL meshes — if the baked swap
    // lands mid-export the GLB round-trips the stale bake and the pipeline
    // can never pick up new geometry.
    if (urlParams.has('export')) return;
    const loader = new GLTFLoader();
    const texLoader = new THREE.TextureLoader();
    const done = new Set<THREE.Group>();
    for (const [wt, g] of this.weapons) {
      if (done.has(g)) continue;
      done.add(g);
      try {
        const [gltf, tex] = await Promise.all([
          loader.loadAsync(`/weapons/w${wt}_baked.glb`),
          texLoader.loadAsync(`/weapons/w${wt}_ao.png?v=${Date.now()}`),
        ]);
        tex.flipY = false;
        // Cycles EMIT bakes are stored linear; tagging sRGB would decode twice
        // and render the albedo ~2 stops dark. Keep it linear.
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        const bakedMat = new THREE.MeshLambertMaterial({ map: tex });
        if (urlParams.has('bakedbg')) { bakedMat.map = null; bakedMat.color.set(0xff00ff); }
        // Chaingun special case: the barrel triad is ANIMATED (spinVel), not
        // static geometry — a merged bake folds it into the body and the gun
        // stops spinning forever. A bake that exports the triad as a node
        // named "barrels" gets adopted as the spin target (with its own small
        // w3b_ao.png bake); a merged bake is skipped so the procedural barrels
        // keep spinning.
        let spinNode: THREE.Object3D | undefined;
        if (wt === WeaponType.Chaingun) {
          // Blender dedups to 'barrels.001' when the group empty lingers.
          gltf.scene.traverse((o) => { if (!spinNode && o.name.startsWith('barrels')) spinNode = o; });
          if (!spinNode) continue;
          this.chainBarrels = spinNode as THREE.Group;
        }
        const swap = new Set<THREE.Object3D>();
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && (m.material as THREE.Material).type !== 'MeshBasicMaterial') swap.add(o);
        });
        for (const o of swap) { o.parent?.remove(o); }
        let barrelMat: THREE.MeshLambertMaterial | null = null;
        if (spinNode) {
          try {
            const btex = await texLoader.loadAsync(`/weapons/w${wt}b_ao.png?v=${Date.now()}`);
            btex.flipY = false;
            btex.colorSpace = THREE.LinearSRGBColorSpace;
            barrelMat = new THREE.MeshLambertMaterial({ map: btex });
          } catch { barrelMat = null; }
        }
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const inBarrels = spinNode && (o === spinNode || spinNode.children.includes(o) || o.parent === spinNode);
          m.material = inBarrels && barrelMat ? barrelMat : bakedMat;
        });
        g.add(gltf.scene);
        // A bake landing mid-cloak must join the ghost set — otherwise the
        // weapon pops back opaque while you're invisible.
        if (this.ghostMats.length) {
          const seen = new Set<THREE.Material>();
          const toShell: THREE.Mesh[] = [];
          gltf.scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            let shelled = false;
            for (const m of mats) {
              if (!m || seen.has(m)) continue;
              seen.add(m);
              if (!m.transparent && !shelled) { toShell.push(mesh); shelled = true; }
              this.ghostify(m);
            }
          });
          for (const mesh of toShell) this.ghostifyMesh(mesh);
        }
        console.log(`[vm] w${wt} baked swap: removed ${swap.size} procedural meshes`);
      } catch (e) { console.log(`[vm] w${wt} bake load failed:`, e); /* procedural+vertexAO stays */ }
    }
  }

  // Per-weapon fire feel: [decay, sideways jitter, flashColor, flashScale, flashLife]
  // Same spring everywhere — only the impulse shape changes per weapon,
  // the Quake approach: one damped oscillator, re-triggered per shot.
  private static readonly KICK_TUNE: Record<number, [number, number, number, number, number]> = {
    [WeaponType.Rocket]:          [12, 0.00, 0xffc866, 1.0, 1.0],   // classic straight-back
    [WeaponType.Disc]:            [16, 0.04, 0x99ddff, 0.7, 0.7],   // snappy, short travel
    [WeaponType.DiscPull]:        [16, 0.04, 0x99ddff, 0.7, 0.7],
    [WeaponType.Chaingun]:        [18, 0.02, 0xffaa44, 0.6, 0.5],   // tiny buzz, no big flash
    [WeaponType.Mortar]:          [7,  0.00, 0xffdd99, 1.6, 1.5],   // slow heavy drop-kick, big flash
    [WeaponType.GrenadeLauncher]: [11, 0.03, 0xffc866, 0.8, 0.9],   // pump pop
    [WeaponType.Flak]:            [10, 0.09, 0xffbb55, 1.3, 1.0],   // hard shove + sideways shudder
    [WeaponType.PlasmaCannon]:          [15, 0.00, 0x44ffbb, 0.5, 0.6],   // light tap, green glow
    [WeaponType.PlasmaGun]:       [14, 0.01, 0x66ccff, 0.35, 0.35], // repeater — small kick, cool flash
    [WeaponType.Railgun]:         [18, 0.01, 0x77ccff, 1.1, 0.9],   // fast snap, cyan discharge
    [WeaponType.Lightning]:       [16, 0.05, 0x8fdcff, 0.4, 0.4],   // per-tick hum — tiny flash, sideways jitter
    [WeaponType.Cannon]:          [8,  0.02, 0xffaa55, 1.5, 1.3],   // heavy naval-gun thump, big warm flash
    [WeaponType.RocketLauncher]:  [10, 0.03, 0xffcc77, 1.3, 1.1],   // launch shove, hot motor bloom
    [WeaponType.Pistol]:          [22, 0.01, 0xffe0a0, 0.35, 0.4],  // snappy crack — tiny flash, quick settle
    [WeaponType.Revolver]:        [8,  0.05, 0xffb060, 1.1, 0.8],   // hand-cannon bark — bigger bloom, heavy push
    [WeaponType.Sticky]:          [13, 0.02, 0xff66dd, 0.8, 0.7],   // thoomp — tube launch, magenta spit
  };

  kick(strength = 1): void {
    const t = ViewModel.KICK_TUNE[this.activeWeapon] ?? ViewModel.KICK_TUNE[WeaponType.Rocket];
    // Velocity impulse, not a position set: rapid shots stack into a bigger
    // swing instead of re-triggering a flat one, and the spring below
    // overshoots rest so the gun snaps rather than slides.
    this.kickVel += strength * 14;
    this.kickDecay = t[0];
    this.kickX = (Math.random() - 0.5) * t[1];
    this.kickRoll = (Math.random() - 0.5) * t[1] * 4 + strength * 0.04;
    if (this.activeWeapon === WeaponType.Chaingun) {
      this.spinVel = Math.min(this.spinVel + strength * 140, ViewModel.SPIN_MAX);
    }
    this.flashMat.color.setHex(t[2]);
    this.flashT = ViewModel.FLASH_LIFE * t[4];
    this.flashLifeScale = t[4];
    this.flashMesh.visible = true;
    this.flashMesh2.visible = true;
    this.flashMesh.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.85 + Math.random() * 0.3) * t[3];
    this.flashMesh.scale.setScalar(s);
    this.flashMesh2.scale.setScalar(s * 0.7);
  }

  /** Camera-space muzzle OFFSET of the active weapon (gun sway/kick/bob
   *  included, camera rotation STRIPPED OUT). The gun group is a child of
   *  vmCam, so a raw getWorldPosition bakes vmCam's rotation into the
   *  result — and vmCam's quaternion is only refreshed inside renderFrame,
   *  which makes it one frame stale to any caller in the update pass.
   *  worldToLocal cancels whatever rotation it carries, yielding the true
   *  local offset; callers rotate by the CURRENT main-camera quaternion
   *  and add the camera position. False for model-less weapons. */
  getMuzzleOffset(out: THREE.Vector3): boolean {
    const n = this.muzzleNodes.get(this.activeWeapon);
    if (!n) return false;
    n.getWorldPosition(out);
    this.vmCam.worldToLocal(out); // strip stale camera rotation → pure offset
    return true;
  }

  startThrow(): void {
    this.throwT = 0;
  }

  // Cloak ghosting — a true "whole-layer" fade, not per-surface alpha.
  // Each opaque mesh gets an invisible depth-only clone that renders in the
  // opaque pass BEFORE the transparent weapon: the silhouette's depth lands
  // in the buffer first, so the transparent pass culls every surface behind
  // the frontmost one. The gun fades against the world while still
  // occluding ITSELF — no backside bleed, no alphaHash grain.
  // Already-transparent stuff (muzzle flash, glow sprites) just dims.
  private ghostMats: { m: THREE.Material; opacity: number; transparent: boolean; depthWrite: boolean }[] = [];
  private ghostShells: THREE.Mesh[] = [];
  private static depthShellMat = new THREE.MeshBasicMaterial({ colorWrite: false });

  private ghostifyMesh(mesh: THREE.Mesh): void {
    const shell = new THREE.Mesh(mesh.geometry, ViewModel.depthShellMat);
    shell.renderOrder = mesh.renderOrder;
    mesh.parent?.add(shell);
    shell.position.copy(mesh.position);
    shell.quaternion.copy(mesh.quaternion);
    shell.scale.copy(mesh.scale);
    this.ghostShells.push(shell);
  }

  private ghostify(m: THREE.Material): void {
    this.ghostMats.push({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });
    m.opacity = Math.min(m.opacity, m.transparent ? 0.25 : 0.3);
    m.transparent = true;
    m.depthWrite = false; // shells own the depth now — color pass only blends
    // `transparent` is a shader define — post-compile flips are inert until
    // the program rebuilds (three.js #23866).
    m.needsUpdate = true;
  }

  setGhost(on: boolean): void {
    if (!on) {
      for (const g of this.ghostMats) {
        g.m.opacity = g.opacity;
        g.m.transparent = g.transparent;
        g.m.depthWrite = g.depthWrite;
        g.m.needsUpdate = true;
      }
      this.ghostMats = [];
      for (const s of this.ghostShells) s.parent?.remove(s);
      this.ghostShells = [];
      return;
    }
    const seen = new Set<THREE.Material>();
    const toShell: THREE.Mesh[] = [];
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {
        const spr = o as THREE.Sprite;
        if (spr.isSprite && spr.material && !seen.has(spr.material)) {
          seen.add(spr.material);
          this.ghostify(spr.material);
        }
        return;
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let shelled = false;
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        if (!m.transparent && !shelled) { toShell.push(mesh); shelled = true; }
        this.ghostify(m);
      }
    });
    for (const mesh of toShell) this.ghostifyMesh(mesh);
  }

  // Energy shield, first-person read: the same hex+fresnel field that wraps
  // the third-person bubble crawls over the gun's surface — the player who
  // raised it sees the charge on their own weapon.
  private shieldShells: THREE.Object3D[] = [];
  private shellColor = 0x66ccff;
  setShield(on: boolean, color = 0x66ccff): void {
    if (!on) {
      for (const s of this.shieldShells) s.parent?.remove(s);
      this.shieldShells = [];
      return;
    }
    if (this.shieldShells.length) return;
    this.shellColor = color;
    const src = this.weapons.get(this.activeWeapon);
    if (!src) return;
    const shell = src.clone(true);
    shell.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = makeShieldMaterial(color);
    });
    shell.scale.setScalar(1.06);
    src.parent?.add(shell);
    this.shieldShells.push(shell);
  }
  // Medkit reuses the gun shell — same field, green read.
  setMend(on: boolean): void { this.setShield(on, 0x3fdd6f); }
  /** Tick the field animation on the gun shells (called from update). */
  private updateShieldShells(dt: number): void {
    for (const s of this.shieldShells) {
      s.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial;
        if (m?.uniforms?.uTime) m.uniforms.uTime.value += dt;
      });
    }
  }

  // Melee swing: sweeps the weapon aside instead of kicking — reads as a
  // punch, not a shot. No flash (melee isn't a discharge).
  punch(): void {
    this.punchT = 0;
    this.fistGroup.visible = true;
  }

  // Lower → swap model at the bottom → raise. Cosmetic only; firing isn't gated.
  switchWeapon(index: number): void {
    if (index === this.activeWeapon && this.switchT < 0) return;
    this.pendingWeapon = index;
    if (this.switchT < 0) this.switchT = 0; // already lowering: just retarget
  }

  update(
    dt: number,
    lookDeltaX: number, // radians turned this frame (yaw)
    lookDeltaY: number, // radians turned this frame (pitch)
    playerVel: THREE.Vector3,
    camera: THREE.PerspectiveCamera
  ): void {
    // tmpQuat is the inverse camera rotation — shared by sway and landing-dip
    // world->camera-space conversions
    camera.getWorldQuaternion(this.tmpQuat).invert();
    this.updateShieldShells(dt);

    // Mouse sway — weapon lags behind look direction
    let moveX = THREE.MathUtils.clamp(-lookDeltaX * SWAY_AMOUNT * 60, -SWAY_MAX, SWAY_MAX);
    let moveY = THREE.MathUtils.clamp(-lookDeltaY * SWAY_AMOUNT * 60 - playerVel.y / 5000, -SWAY_MAX, SWAY_MAX);

    // World velocity offset in camera space (moving forward dips the gun)
    this.tmpDir.copy(playerVel).multiplyScalar(VEL_AMOUNT);
    const len = Math.min(this.tmpDir.length(), VEL_MAX);
    this.tmpDir.normalize().multiplyScalar(len);
    this.tmpDir.applyQuaternion(this.tmpQuat); // world -> camera local
    // forward motion converts to slight downward push
    const fwdToVert = Math.max(0, this.tmpDir.z * -1); // -z is forward
    moveX -= this.tmpDir.x;
    moveY -= this.tmpDir.y - fwdToVert;

    // Cheap perlin-ish bob (layered sines, close enough at this amplitude)
    this.timer += BOB_SPEED * dt;
    const bobX = (Math.sin(this.timer) * 0.6 + Math.sin(this.timer * 1.73) * 0.4) * BOB_HEIGHT;
    const bobY = (Math.cos(this.timer * 0.87) * 0.6 + Math.cos(this.timer * 1.31) * 0.4) * BOB_HEIGHT;

    // Landing dip — big downward vel changes kick the gun
    let fallX = 0, fallY = 0, fallZ = 0;
    const velJump = playerVel.y - this.lastFrameYVel;
    if (velJump >= FALL_THRESHOLD) {
      this.tmpDir.copy(this.lastFrameVel).normalize().multiplyScalar(
        Math.min(velJump * FALL_MULT, FALL_MAX)
      ).applyQuaternion(this.tmpQuat);
      fallX = this.tmpDir.x; fallY = this.tmpDir.y; fallZ = this.tmpDir.z;
    }

    // Fire kick — underdamped spring on velocity, not a decaying position
    // offset: sharp impulse in, slight overshoot past rest, settle. That's
    // the difference between "snap" and "slide" — ζ≈0.55 keeps one visible
    // bounce-back without ringing.
    const s = this.kickDecay * 2.2;
    this.kickVel += (-this.kickAmount * s * s - this.kickVel * 1.1 * s) * dt;
    this.kickAmount += this.kickVel * dt;
    this.kickX *= Math.exp(-dt * this.kickDecay * 1.4); // jitter settles faster than the shove
    const kickZ = this.kickAmount * 0.36;
    const kickY = this.kickAmount * 0.08;
    const dip = this.updateThrowDip(dt);
    const switchDip = this.updateSwitchDip(dt);
    const punch = this.updatePunchDip(dt);
    const totalDip = Math.max(dip, switchDip);

    const target = this.tmpDir.set(
      REST_POS.x + moveX + bobX + fallX + this.kickX * this.kickAmount + punch * PUNCH_X,
      REST_POS.y + moveY + bobY + fallY + kickY + dip * THROW_DIP_Y + switchDip * SWITCH_DIP_Y + punch * PUNCH_Y,
      REST_POS.z + fallZ + kickZ + dip * THROW_DIP_Z + punch * PUNCH_Z
    );
    // Snap fast to the kicked pose so the punch is actually visible
    this.group.position.lerp(target, Math.min(dt * 20, 1));
    this.group.rotation.x = this.baseRotX + this.kickAmount * 0.28 + dip * THROW_DIP_ROT + switchDip * SWITCH_DIP_ROT + punch * PUNCH_ROT;
    this.group.rotation.z = this.baseRotZ + totalDip * THROW_DIP_ROLL + punch * PUNCH_ROLL
      + this.kickRoll * this.kickAmount;

    // Chaingun barrel spin — decays over ~0.7s after firing stops
    if (this.chainBarrels && this.spinVel > 0) {
      this.chainBarrels.rotation.z += this.spinVel * dt;
      this.spinVel *= Math.exp(-dt * 4);
      if (this.spinVel < 0.5) this.spinVel = 0;
    }

    // Flash decay — sqrt curve: bright spike, fast falloff
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(this.flashT / (ViewModel.FLASH_LIFE * this.flashLifeScale), 0);
      this.flashMat.opacity = Math.sqrt(k);
      if (this.flashT <= 0) { this.flashMesh.visible = false; this.flashMesh2.visible = false; }
    }

    this.lastFrameYVel = playerVel.y;
    this.lastFrameVel.copy(playerVel);
  }

  // Throw anim: quick lower, hold through release, spring back up
  private updateThrowDip(dt: number): number {
    if (this.throwT < 0) return 0;
    this.throwT += dt;
    const t = this.throwT;
    if (t >= THROW_TOTAL) {
      this.throwT = -1;
      return 0;
    }
    if (t < THROW_LOWER_TIME) return t / THROW_LOWER_TIME;
    if (t < THROW_RELEASE + 0.07) return 1;
    return Math.max(0, 1 - (t - THROW_RELEASE - 0.07) / THROW_RAISE_TIME);
  }

  // Weapon switch: lower, swap at the bottom, raise
  private updateSwitchDip(dt: number): number {
    if (this.switchT < 0) return 0;
    this.switchT += dt;
    const t = this.switchT;
    if (t < SWITCH_LOWER_TIME) return t / SWITCH_LOWER_TIME;
    if (this.pendingWeapon >= 0 && this.pendingWeapon !== this.activeWeapon) {
      const prev = this.weapons.get(this.activeWeapon);
      if (prev) prev.visible = false;
      this.activeWeapon = this.pendingWeapon;
      const next = this.weapons.get(this.activeWeapon);
      if (next) next.visible = true;
      // The field shell wraps the OLD gun's silhouette — re-wrap the new one.
      if (this.shieldShells.length) { this.setShield(false); this.setShield(true, this.shellColor); }
      // Park the flash at this weapon's actual muzzle, not a shared offset
      const mz = ViewModel.MUZZLE_Z[this.activeWeapon] ?? -0.35;
      this.flashMesh.position.z = mz;
      this.flashMesh2.position.z = mz;
    }
    const dip = Math.max(0, 1 - (t - SWITCH_LOWER_TIME) / SWITCH_RAISE_TIME);
    if (dip <= 0) { this.switchT = -1; this.pendingWeapon = -1; }
    return dip;
  }

  // Punch swing envelope: snap in, brief apex hold, spring back out.
  // Also flies the fist — weapon envelope drives the gun, this moves the glove.
  private updatePunchDip(dt: number): number {
    if (this.punchT < 0) return 0;
    this.punchT += dt;
    const t = this.punchT;
    if (t >= PUNCH_TOTAL) {
      this.punchT = -1;
      this.fistGroup.visible = false;
      this.fistGroup.position.copy(FIST_OFF);
      return 0;
    }
    let env: number;
    if (t < PUNCH_IN) env = t / PUNCH_IN;
    else if (t < PUNCH_IN + PUNCH_HOLD) env = 1;
    else env = 1 - (t - PUNCH_IN - PUNCH_HOLD) / PUNCH_OUT;
    // Fist leads: it jabs in on the weapon's way out and snaps back first
    const ft = t < PUNCH_IN ? t / PUNCH_IN : t < PUNCH_IN + PUNCH_HOLD + 0.05 ? 1 : Math.max(0, 1 - (t - PUNCH_IN - PUNCH_HOLD - 0.05) / 0.12);
    const ease = 1 - (1 - ft) * (1 - ft); // ease-out — fast launch, lands hard
    this.fistGroup.position.lerpVectors(FIST_OFF, FIST_JAB, ease);
    return env;
  }
}
