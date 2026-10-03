import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import { buildWeaponMeshes, buildHandAndFlash } from './viewmodel/weaponsGeo.js';
import * as vm from './vmGhost.js';
import { kickF } from './vmKick.js';
import { VmEnvelopes } from './vmEnvelopes.js';
import { VmBaked } from './vmBaked.js';
// Timing constants live with the envelopes — re-export so Player/fire.ts
// keep importing them from the file they already know.
export { THROW_RELEASE, THROW_TOTAL, SIDEARM_DRAW_TIME } from './vmEnvelopes.js';

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

const THROW_DIP_Y = -0.22;
const THROW_DIP_Z = 0.06;
const THROW_DIP_ROT = -0.12; // slight muzzle-down tilt, gun stays level-ish
const THROW_DIP_ROLL = 0.18; // rolls outward, weapon tips to the right

const SWITCH_DIP_Y = -0.34;
const SWITCH_DIP_ROT = -0.35; // muzzle tips down as it holsters

const PUNCH_X = 0.18;    // gun swings right
const PUNCH_Y = -0.3;    // and deep — nearly holstered, not a recoil
const PUNCH_Z = 0.06;
const PUNCH_ROLL = 0.5;
const PUNCH_ROT = -0.35; // muzzle tips DOWN (negative like switch) — butt-up sweep, never recoil-up

export class ViewModel {
  readonly group: THREE.Group;
  // Keyed by WeaponType — the array order used to collide with the enum
  // (Chaingun=3 showed the mortar mesh, Railgun=9 indexed past the end).
  weapons = new Map<number, THREE.Group>(); // public — envelopes swap visibility
  // Empty node parked at each weapon's muzzle — world position IS the
  // attachment point for beam VFX, so the bolt tracks sway/kick exactly.
  private muzzleNodes = new Map<number, THREE.Object3D>();
  // Muzzle Z per weapon (model space) so the flash sits AT the bore,
  // not at a fixed offset that floats ahead of stubby barrels.
  private static readonly MUZZLE_Z: Record<number, number> = {
    [WeaponType.BoltLauncher]: -0.36, // flush bore face, just past the end plate [WeaponType.Disc]: -0.36, [WeaponType.DiscPull]: -0.36, // just past the face plate
    [WeaponType.Chaingun]: -0.80, // just past the cluster + clamp, incl. the group's +0.15 pullback [WeaponType.Mortar]: -0.28, [WeaponType.GrenadeLauncher]: -0.42,
    [WeaponType.Flak]: -0.28, [WeaponType.PlasmaCannon]: -0.35, [WeaponType.PlasmaGun]: -0.26, [WeaponType.Sprinkler]: -0.30,
    [WeaponType.Railgun]: -0.64, // clear of the prong cluster — at -0.57 the hex tips frame-swallow the flash
    [WeaponType.Shotgun]: -0.41, [WeaponType.Cannon]: -0.53,
    [WeaponType.RocketLauncher]: -0.44, // just past the warhead tip
    [WeaponType.Lightning]: -0.42, // emitter ball at the prong tips
    [WeaponType.Sticky]: -0.40,
    [WeaponType.Pistol]: -0.17,   // stubby barrel face
    [WeaponType.Revolver]: -0.27, // long barrel + underlug tip
    [WeaponType.Repair]: -0.20,   // emitter stud on the reflector dish
    [WeaponType.MRVLauncher]: -0.56, // group-space: scaled bore face (-0.445 model) ×1.25
  };
  chainBarrels: THREE.Group | null = null; // public — VmBaked reseats the bake's pivot
  // Bore axis in the SPIN NODE's local space — procedural barrels run
  // along -Z, but an adopted bake node carries Blender's export axes, so
  // a blind rotation.z cartwheels the triad. Computed at adoption.
  spinAxis = new THREE.Vector3(0, 0, -1); // public — VmBaked recomputes bore axes
  spinVel = 0;
  private static readonly SPIN_MAX = 40; // rad/s at full spin
  activeWeapon = 0; // public — the switch envelope rewrites it at the dip
  private timer = 0;
  private aimBlend = 0;
  private kickAmount = 0;
  kickVel = 0;       // spring velocity — impulse IN, overshoot settle
  kickX = 0;         // sideways kick — flak/melee shudder
  kickRoll = 0;      // per-shot roll — alternating twist reads as torque
  kickDecay = 12;    // per-weapon spring rate
  kickAmp = 1;       // per-weapon muzzle-rise multiplier
  kickBack = 1;      // per-weapon backward-shove multiplier (kickZ scale)
  flashLifeScale = 1;
  flashLightI = 5; // peak intensity of the current pop — set per weapon in kickF
  fistGroup: THREE.Group; // public — the punch envelope flies it
  private baseRotX = 0.04;
  private baseRotZ = 0;
  flashMesh: THREE.Mesh;  // public — the switch envelope re-parks it
  flashMesh2: THREE.Mesh;
  flashMat: THREE.MeshBasicMaterial;
  flashLight: THREE.PointLight;
  flashBaseS = 1;
  flashBaseS2 = 1;
  flashT = 0;
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
    this.baked.load();

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

  /** Same round-trip for an arbitrary vm-space point (e.g. the emitter
   *  ball's world position): renders where the point sits on screen
   *  through vmCam, then back out through the main camera's ray. */
  anchorWorldPoint(vmWorld: THREE.Vector3, cam: THREE.Camera, out: THREE.Vector3): boolean {
    this.vmCam.quaternion.copy(cam.quaternion);
    this.vmCam.updateMatrixWorld();
    out.copy(this.vmCam.worldToLocal(vmWorld));
    out.applyMatrix4(this.vmCam.projectionMatrix);
    cam.updateMatrixWorld();
    out.unproject(cam);
    return true;
  }

  // Per-weapon fire feel: [decay, sideways jitter, flashColor, flashScale, flashLife, rise]
  // Same spring everywhere — only the impulse shape changes per weapon,
  // the Quake approach: one damped oscillator, re-triggered per shot.
  // `rise` scales muzzle-up pitch + back-thrust so weapons differ in
  // character, not just shove depth (mortar heaves, pistol snaps).
  kick(strength = 1): void {
    kickF(this, strength);
    if (this.activeWeapon === WeaponType.Chaingun) this.startBarrelKick();
    if (this.activeWeapon === WeaponType.Disc || this.activeWeapon === WeaponType.DiscPull) {
      // Spinfusor fake: the chambered disc IS the projectile — it's gone
      // the instant the shot breaks. The NEXT disc slides forward out of
      // the breech into the slit during the refire gap.
      if (!this.discAmmo) this.discAmmo = this.weapons.get(WeaponType.Disc)?.getObjectByName('discAmmo') ?? null;
      if (this.discAmmo) { this.discAmmo.visible = false; this.discT = 0; }
    }
  }

  private discAmmo: THREE.Object3D | null = null;
  private discT = -1; // <0 idle; >=0 ms since the shot ejected the chambered disc
  private static readonly DISC_HIDE = 0.06;  // blink gap before the reload slide
  // ~75% of DISC_RATE (1.0s) total — a lazy feed reads as machinery, and
  // a fast snap would be invisible behind the kick anyway.
  private static readonly DISC_SLIDE = 0.69; // breech→slit travel
  private static readonly DISC_BACK = 0.2;   // park depth inside the breech

  // Chaingun per-shot tell: knock the TOP barrel (the one feeding) back a
  // beat, spring it home before the next round. At full spin it's ~mush —
  // a barrel holds top for ~50ms — but it reads during spin-up.
  private barrelKickIdx = -1;
  private barrelKickT = 0;
  private chainSpin = 0; // accumulated spin angle — the euler can't be
                         // read back cleanly once roll is composed in
  private startBarrelKick(): void {
    if (!this.chainBarrels) return;
    const phi = -this.chainSpin; // rotateOnAxis runs about local -Z
    let bi = -1, by = -Infinity;
    this.chainBarrels.children.forEach((c, i) => {
      if (!c.userData.barrel) return;
      const y = c.position.x * Math.sin(phi) + c.position.y * Math.cos(phi);
      if (y > by) { by = y; bi = i; }
    });
    this.barrelKickIdx = bi;
    this.barrelKickT = 0.08;
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

  /** Dip-cycle family (throw/switch/punch envelopes) — own file
   *  (vmEnvelopes.ts); the public triggers stay as delegates. */
  private env = new VmEnvelopes(this);
  private baked = new VmBaked(this);
  muzzleZ(wt: number): number { return ViewModel.MUZZLE_Z[wt] ?? -0.35; }

  /** Re-park a weapon's muzzle node on a model feature (e.g. the LG's
   *  emitter ball) so every consumer of the node — beam anchor, flash —
   *  tracks the authored geometry instead of the tuned constant. */
  parkMuzzleAt(wt: number, worldPos: THREE.Vector3): boolean {
    const n = this.muzzleNodes.get(wt);
    if (!n?.parent) return false;
    n.parent.updateWorldMatrix(true, false);
    n.position.copy(n.parent.worldToLocal(worldPos.clone()));
    return true;
  }

  /** Flash park point in GROUP space — the muzzle NODE's real position
   *  plus a small forward push past the bore face. z-only parking left
   *  the quads on the group axis (x=0,y=0): for guns whose bore sits
   *  off-axis the flash rendered buried inside the body, never visible. */
  muzzleGroupPos(wt: number, out: THREE.Vector3): boolean {
    const n = this.muzzleNodes.get(wt);
    if (!n) return false;
    n.updateWorldMatrix(true, false);
    n.getWorldPosition(out);
    this.group.worldToLocal(out); // strip camera — pure group-space point
    out.z -= 0.04; // proud of the bore face — a flush quad occludes/z-fights
    return true;
  }

  startThrow(timeScale = 1): void {
    this.env.startThrow(timeScale);
  }

  // Cloak ghosting — a true "whole-layer" fade, not per-surface alpha.
  // Each opaque mesh gets an invisible depth-only clone that renders in the
  // opaque pass BEFORE the transparent weapon: the silhouette's depth lands
  // in the buffer first, so the transparent pass culls every surface behind
  // the frontmost one. The gun fades against the world while still
  // occluding ITSELF — no backside bleed, no alphaHash grain.
  // Already-transparent stuff (muzzle flash, glow sprites) just dims.
  ghostMats: // public — VmBaked joins bakes mid-cloak
   { m: THREE.Material; opacity: number; transparent: boolean; depthWrite: boolean }[] = [];
  ghostShells: THREE.Mesh[] = [];

  ghostifyMesh(mesh: THREE.Mesh): void { vm.ghostifyMesh(this, mesh); } // public — VmBaked
  ghostify(m: THREE.Material): void { vm.ghostify(this, m); } // public — VmBaked
  setGhost(on: boolean): void { vm.setGhost(this, on); }
  // Energy shield, first-person read: the same hex+fresnel field that wraps
  // the third-person bubble crawls over the gun's surface.
  shieldShells: THREE.Object3D[] = []; // public — switch envelope re-wraps
  shellColor = 0x66ccff;
  setShield(on: boolean, color = 0x66ccff): void { vm.setShield(this, on, color); }
  // Medkit reuses the gun shell — same field, green read.
  setMend(on: boolean): void { vm.setShield(this, on, 0x3fdd6f); }
  /** Tick the field animation on the gun shells (called from update). */
  updateShieldShells(dt: number): void { vm.updateShieldShells(this, dt); }

  punch(landed = false): void {
    this.env.punch(landed);
  }

  switchWeapon(index: number): void {
    this.env.switchWeapon(index);
  }

  update(
    dt: number,
    lookDeltaX: number, // radians turned this frame (yaw)
    lookDeltaY: number, // radians turned this frame (pitch)
    playerVel: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    firing = false
  ): void {
    // Firing steadies the gun: lateral velocity sway and walk-bob damp
    // toward zero while the trigger's hot, so strafing under fire stops
    // waddling the weapon side to side.
    this.aimBlend += ((firing ? 1 : 0) - this.aimBlend) * Math.min(dt * 10, 1);
    const hold = 1 - this.aimBlend * 0.85;
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
    moveX -= this.tmpDir.x * hold;
    moveY -= this.tmpDir.y - fwdToVert;

    // Cheap perlin-ish bob (layered sines, close enough at this amplitude)
    this.timer += BOB_SPEED * dt;
    const bobX = (Math.sin(this.timer) * 0.6 + Math.sin(this.timer * 1.73) * 0.4) * BOB_HEIGHT * hold;
    const bobY = (Math.cos(this.timer * 0.87) * 0.6 + Math.cos(this.timer * 1.31) * 0.4) * BOB_HEIGHT * hold;

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
    const kickZ = this.kickAmount * 0.55 * this.kickBack;
    const kickY = this.kickAmount * 0.12;
    const { dip, switchDip, punch } = this.env.tick(dt);
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

    this.tickChainBarrels(dt);
    this.tickDiscAmmo(dt);

    // Flash decay — sqrt curve: bright spike, fast falloff. The two quads
    // grow/shrink in opposite directions (Effekseer's recipe — mirrored
    // envelopes read as an event, identical ones read flat), and the
    // muzzle light dies on the same curve.
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(this.flashT / (ViewModel.FLASH_LIFE * this.flashLifeScale), 0);
      this.flashMat.opacity = Math.sqrt(k);
      this.flashLight.intensity = this.flashLightI * k;
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

  /** Chaingun cluster tick — spin decay (~0.7s coast after firing stops)
   *  plus the per-barrel recoil spring: the knocked barrel rides back on
   *  its own short envelope, independent of the whole-gun kick. */
  private tickChainBarrels(dt: number): void {
    if (this.chainBarrels && this.spinVel > 0) {
      this.chainBarrels.rotateOnAxis(this.spinAxis, this.spinVel * dt);
      this.chainSpin += this.spinVel * dt;
      this.spinVel *= Math.exp(-dt * 4);
      if (this.spinVel < 0.5) this.spinVel = 0;
    }
    if (this.barrelKickIdx < 0 || !this.chainBarrels) return;
    const b = this.chainBarrels.children[this.barrelKickIdx];
    if (!b) { this.barrelKickIdx = -1; return; }
    this.barrelKickT = Math.max(0, this.barrelKickT - dt);
    const k = this.barrelKickT / 0.08;
    b.position.z = b.userData.baseZ - k * k * 0.06; // squared: snap out, settle home
    if (this.barrelKickT <= 0) { b.position.z = b.userData.baseZ; this.barrelKickIdx = -1; }
  }

  /** Disc rechamber: hidden during the blink gap, then the next disc
   *  slides forward out of the breech into the slit, spinning — ease-out
   *  cubic so it seats with a snap rather than a drift. */
  private tickDiscAmmo(dt: number): void {
    if (this.discT < 0 || !this.discAmmo) return;
    this.discT += dt;
    if (this.discT < ViewModel.DISC_HIDE) return;
    this.discAmmo.visible = true;
    const k = Math.min((this.discT - ViewModel.DISC_HIDE) / ViewModel.DISC_SLIDE, 1);
    const e = 1 - (1 - k) * (1 - k) * (1 - k);
    this.discAmmo.position.z = ViewModel.DISC_BACK * (1 - e);
    // Rim (r 0.115) is wider than the body apothem (~0.10) — a full-size
    // disc parked deep would leak cyan through the flanks. Spawn it small
    // inside the breech and grow as it slides; the clip is hidden anyway.
    this.discAmmo.scale.setScalar(0.55 + 0.45 * e);
    if (k >= 1) {
      this.discAmmo.position.z = 0;
      this.discAmmo.scale.setScalar(1);
      this.discT = -1;
    }
  }
}
