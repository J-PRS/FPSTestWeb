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
    [WeaponType.Rocket]: -0.36, // flush bore face, just past the end plate [WeaponType.Disc]: -0.46, [WeaponType.DiscPull]: -0.46, // just past the fork's prong tips
    [WeaponType.Chaingun]: -0.55, // just past the barrel cluster tips [WeaponType.Mortar]: -0.28, [WeaponType.GrenadeLauncher]: -0.42,
    [WeaponType.Flak]: -0.28, [WeaponType.PlasmaCannon]: -0.35, [WeaponType.PlasmaGun]: -0.26, [WeaponType.Sprinkler]: -0.26,
    [WeaponType.Railgun]: -0.43,
    [WeaponType.Shotgun]: -0.41, [WeaponType.Cannon]: -0.53,
    [WeaponType.RocketLauncher]: -0.44, // just past the warhead tip
    [WeaponType.Lightning]: -0.42, // emitter ball at the prong tips
    [WeaponType.Sticky]: -0.40,
    [WeaponType.Pistol]: -0.17,   // stubby barrel face
    [WeaponType.Revolver]: -0.27, // long barrel + underlug tip
    [WeaponType.Repair]: -0.20,   // emitter stud on the reflector dish
  };
  private chainBarrels: THREE.Group | null = null;
  // Bore axis in the SPIN NODE's local space — procedural barrels run
  // along -Z, but an adopted bake node carries Blender's export axes, so
  // a blind rotation.z cartwheels the triad. Computed at adoption.
  private spinAxis = new THREE.Vector3(0, 0, -1);
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
  private kickAmp = 1;       // per-weapon muzzle-rise multiplier
  private flashLifeScale = 1;
  private throwT = -1;
  private punchT = -1;
  private fistGroup: THREE.Group;
  private baseRotX = 0.04;
  private baseRotZ = 0;
  private flashMesh: THREE.Mesh;
  private flashMesh2: THREE.Mesh;
  private flashMat: THREE.MeshBasicMaterial;
  private flashLight: THREE.PointLight;
  private flashBaseS = 1;
  private flashBaseS2 = 1;
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
    // Vertex AO is NOT baked here: the bake is 16 raycasts/vertex against an
    // unindexed merged mesh (~1-4s across all weapons), and weapons that end
    // up GLB-swapped discard the result entirely. loadBakedWeapons bakes AO
    // only on weapons whose bake fetch misses — i.e. the ones that actually
    // stay procedural.
    this.loadBakedWeapons();

    const hf = buildHandAndFlash(this.group);
    this.fistGroup = hf.fistGroup;
    this.flashMat = hf.flashMat;
    this.flashMesh = hf.flashMesh;
    this.flashMesh2 = hf.flashMesh2;
    // Muzzle light — the half of a retro flash nobody draws: for ~60ms
    // the shot actually LIGHTS the gun and hands. Parented to the quad so
    // it inherits the per-weapon muzzle park and sway/kick for free.
    this.flashLight = new THREE.PointLight(0xffffff, 0, 2.2, 2);
    this.flashLight.visible = false;
    this.flashMesh.add(this.flashLight);

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
    // can never pick up new geometry. Still bake AO: the dump pipeline
    // round-trips the procedural vertex colors into the GLB.
    if (urlParams.has('export')) {
      for (const g of this.weapons.values()) bakeVertexAO(g);
      return;
    }
    const loader = new GLTFLoader();
    const texLoader = new THREE.TextureLoader();
    const done = new Set<THREE.Group>();
    for (const [wt, g] of this.weapons) {
      if (done.has(g)) continue;
      done.add(g);
      try {
        // HEAD-probe first: a missing GLB makes the dev server serve the
        // 404 HTML page, which then fails PARSING — the miss arrives as a
        // real Error, indistinguishable from a corrupt bake. Probing keeps
        // expected misses from ever becoming fetch/parse noise.
        const probe = await fetch(`/weapons/w${wt}_baked.glb`, { method: 'HEAD' });
        // Vite's SPA fallback can 200 a HEAD for a missing file — only a
        // non-HTML body is a real bake.
        const ct = probe.headers.get('content-type') ?? '';
        if (!probe.ok || ct.includes('html')) { bakeVertexAO(g); continue; }
        await this.swapBaked(wt, g, loader, texLoader);
      } catch (e) {
        // Fetch missed → this weapon stays procedural, so bake its vertex
        // AO now (deferred from the ctor: swapped weapons would discard it).
        bakeVertexAO(g);
        // A missing bake is the normal case — no w{id}_baked.glb/ao.png
        // shipped for this weapon, so the procedural+vertexAO mesh stays.
        // 404s surface as Event/ProgressEvent (ImageLoader) or "Not
        // Found"/404 Errors (FileLoader/fetch) — neither is worth a log
        // line. Only a real parse/decode failure (an Error that doesn't
        // name a missing file) is.
        const is404 = !(e instanceof Error) ||
          /404|not found|fetch/i.test(e.message);
        if (!is404) console.log(`[vm] w${wt} bake load failed:`, e);
      }
    }
  }

  // One weapon's bake swap: fetch glb+AO, replace non-glow procedural
  // meshes with the bake, seat the chaingun spin pivot, ghost it if a
  // cloak is active. Throws on missing bakes — the caller treats 404 as
  // "procedural stays", silently.
  private async swapBaked(wt: number, g: THREE.Group, loader: GLTFLoader, texLoader: THREE.TextureLoader): Promise<void> {
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
    // stops spinning forever. null = merged bake, procedural barrels keep
    // spinning and this weapon's swap is skipped.
    const spin = wt === WeaponType.Chaingun
      ? await this.adoptChainSpin(gltf.scene, wt, texLoader) : null;
    if (wt === WeaponType.Chaingun && !spin) return;
    const swap = new Set<THREE.Object3D>();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).type !== 'MeshBasicMaterial') swap.add(o);
    });
    for (const o of swap) { o.parent?.remove(o); }
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const inBarrels = spin && (o === spin.node || spin.node.children.includes(o) || o.parent === spin.node);
      m.material = inBarrels && spin.barrelMat ? spin.barrelMat : bakedMat;
    });
    g.add(gltf.scene);
    if (spin) this.seatChainPivot(spin.node, g);
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
  }

  // Find the bake's "barrels" node (Blender dedups to 'barrels.001' when
  // the group empty lingers) and fetch its own small w{id}b_ao.png bake.
  // Returns null on a merged bake — the swap is then skipped entirely.
  private async adoptChainSpin(scene: THREE.Object3D, wt: number, texLoader: THREE.TextureLoader):
    Promise<{ node: THREE.Object3D; barrelMat: THREE.MeshLambertMaterial | null } | null> {
    let node: THREE.Object3D | undefined;
    scene.traverse((o) => { if (!node && o.name.startsWith('barrels')) node = o; });
    if (!node) return null;
    this.chainBarrels = node as THREE.Group;
    let barrelMat: THREE.MeshLambertMaterial | null = null;
    try {
      const btex = await texLoader.loadAsync(`/weapons/w${wt}b_ao.png?v=${Date.now()}`);
      btex.flipY = false;
      btex.colorSpace = THREE.LinearSRGBColorSpace;
      barrelMat = new THREE.MeshLambertMaterial({ map: btex });
    } catch { barrelMat = null; }
    return { node, barrelMat };
  }

  // The bake node's origin isn't the cluster center — spinning it
  // directly orbits the triad around one barrel. Wrap it in a pivot
  // seated on the bore line (weapon-space x=0,y=0 at barrel z) and spin
  // THAT. Matrix math runs after the reparent so matrixWorld already
  // includes g's transform.
  private seatChainPivot(spinNode: THREE.Object3D, g: THREE.Group): void {
    if (!spinNode.parent) return;
    const boreCenter = new THREE.Vector3(0, 0, -0.28); // cluster z in weapon space
    const parent = spinNode.parent;
    parent.updateWorldMatrix(true, false);
    g.updateWorldMatrix(true, false);
    const parentInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const pivot = new THREE.Group();
    pivot.position.copy(boreCenter.applyMatrix4(
      new THREE.Matrix4().copy(parentInv).multiply(g.matrixWorld)));
    parent.add(pivot);
    pivot.attach(spinNode);
    // Bore dir (-Z in weapon space) into the pivot's local axes —
    // the pivot is unrotated, so this is just parent-space.
    this.spinAxis.set(0, 0, -1)
      .transformDirection(new THREE.Matrix4().copy(parentInv).multiply(g.matrixWorld));
    this.chainBarrels = pivot;
  }

  // Per-weapon fire feel: [decay, sideways jitter, flashColor, flashScale, flashLife, rise]
  // Same spring everywhere — only the impulse shape changes per weapon,
  // the Quake approach: one damped oscillator, re-triggered per shot.
  // `rise` scales muzzle-up pitch + back-thrust so weapons differ in
  // character, not just shove depth (mortar heaves, pistol snaps).
  private static readonly KICK_TUNE: Record<number, [number, number, number, number, number, number]> = {
    [WeaponType.Rocket]:          [12, 0.00, 0xffc866, 1.0, 1.0, 1.0],  // classic straight-back
    [WeaponType.Disc]:            [16, 0.04, 0x99ddff, 0.7, 0.7, 0.9],  // snappy, short travel
    [WeaponType.DiscPull]:        [16, 0.04, 0x99ddff, 0.7, 0.7, 0.9],
    [WeaponType.Chaingun]:        [18, 0.02, 0xffaa44, 0.6, 0.5, 0.5],  // tiny buzz, no big flash
    [WeaponType.Mortar]:          [7,  0.00, 0xffdd99, 1.6, 1.5, 1.0],  // slow heavy heave, big flash
    [WeaponType.GrenadeLauncher]: [11, 0.03, 0xffc866, 0.8, 0.9, 0.9],  // pump pop
    [WeaponType.Flak]:            [10, 0.09, 0xffbb55, 1.3, 1.0, 1.1],  // hard shove + sideways shudder
    [WeaponType.PlasmaCannon]:          [15, 0.00, 0x44ffbb, 0.5, 0.6, 0.7],  // light tap, green glow
    [WeaponType.PlasmaGun]:       [14, 0.01, 0x66ccff, 0.35, 0.35, 0.5],// repeater — small kick, cool flash
    [WeaponType.Sprinkler]:       [15, 0.02, 0xaaff66, 0.55, 1.5, 0.45],// hose — light wobble; 105ms flash ~bridges the shot gap → lit nozzle
    [WeaponType.Railgun]:         [18, 0.01, 0x77ccff, 1.1, 0.9, 1.2],  // fast snap, cyan discharge
    [WeaponType.Lightning]:       [16, 0.05, 0x8fdcff, 0.4, 0.4, 0.4],  // per-tick hum — tiny flash, sideways jitter
    [WeaponType.Cannon]:          [8,  0.02, 0xffaa55, 1.5, 1.3, 1.1],  // heavy naval-gun thump, big warm flash
    [WeaponType.RocketLauncher]:  [10, 0.03, 0xffcc77, 1.3, 1.1, 1.2],  // launch shove, hot motor bloom
    [WeaponType.Pistol]:          [22, 0.01, 0xffe0a0, 0.35, 0.4, 1.1], // snappy crack — muzzle flip, quick settle
    [WeaponType.Revolver]:        [8,  0.05, 0xffb060, 1.1, 0.8, 1.3],  // hand-cannon bark — big muzzle flip
    [WeaponType.Sticky]:          [13, 0.02, 0xff66dd, 0.8, 0.7, 0.9],  // thoomp — tube launch, magenta spit
    [WeaponType.Repair]:          [16, 0.05, 0x7dffb8, 0.4, 0.4, 0.4],  // per-tick hum — green weld spark
  };

  kick(strength = 1): void {
    const t = ViewModel.KICK_TUNE[this.activeWeapon] ?? ViewModel.KICK_TUNE[WeaponType.Rocket];
    // Velocity impulse, not a position set: rapid shots stack into a bigger
    // swing instead of re-triggering a flat one, and the spring below
    // overshoots rest so the gun snaps rather than slides.
    this.kickVel += strength * 22;
    this.kickDecay = t[0];
    this.kickAmp = t[5];
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
    this.flashBaseS = s;
    this.flashBaseS2 = s * 0.7;
    this.flashMesh.scale.setScalar(s);
    this.flashMesh2.scale.setScalar(this.flashBaseS2);
    // 60-100ms light pop — reads as "the shot lit the room", not a decal.
    this.flashLight.color.setHex(t[2]);
    this.flashLight.intensity = 5;
    this.flashLight.visible = true;
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
    // Ceiling on travel — heavy weapons (mortar/cannon at strength ~2)
    // slam into it instead of flying the gun off-screen.
    if (this.kickAmount > 0.85) { this.kickAmount = 0.85; this.kickVel = Math.min(this.kickVel, 0); }
    this.kickX *= Math.exp(-dt * this.kickDecay * 1.4); // jitter settles faster than the shove
    const kickZ = this.kickAmount * 0.55;
    const kickY = this.kickAmount * 0.12;
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
    // Muzzle rise is the readable half of a kick — pitch up hard
    // (×0.55, was 0.28 → ~10° at full strength, mortar/cannon more)
    this.group.rotation.x = this.baseRotX + this.kickAmount * 0.7 * this.kickAmp + dip * THROW_DIP_ROT + switchDip * SWITCH_DIP_ROT + punch * PUNCH_ROT;
    this.group.rotation.z = this.baseRotZ + totalDip * THROW_DIP_ROLL + punch * PUNCH_ROLL
      + this.kickRoll * this.kickAmount;

    // Chaingun barrel spin — decays over ~0.7s after firing stops
    if (this.chainBarrels && this.spinVel > 0) {
      this.chainBarrels.rotateOnAxis(this.spinAxis, this.spinVel * dt);
      this.spinVel *= Math.exp(-dt * 4);
      if (this.spinVel < 0.5) this.spinVel = 0;
    }

    // Flash decay — sqrt curve: bright spike, fast falloff. The two quads
    // grow/shrink in opposite directions (Effekseer's recipe — mirrored
    // envelopes read as an event, identical ones read flat), and the
    // muzzle light dies on the same curve.
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(this.flashT / (ViewModel.FLASH_LIFE * this.flashLifeScale), 0);
      this.flashMat.opacity = Math.sqrt(k);
      this.flashLight.intensity = 5 * k;
      this.flashMesh.scale.setScalar(this.flashBaseS * (1 + (1 - k) * 0.9));
      this.flashMesh2.scale.setScalar(this.flashBaseS2 * (0.4 + k * 0.6));
      if (this.flashT <= 0) {
        this.flashMesh.visible = false;
        this.flashMesh2.visible = false;
        this.flashLight.visible = false;
      }
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
