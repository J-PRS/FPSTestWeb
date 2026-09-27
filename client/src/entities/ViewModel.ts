import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';

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
const THROW_TOTAL = THROW_RELEASE + THROW_RAISE_TIME + 0.05;
const THROW_DIP_Y = -0.22;
const THROW_DIP_Z = 0.06;
const THROW_DIP_ROT = -0.12; // slight muzzle-down tilt, gun stays level-ish
const THROW_DIP_ROLL = 0.18; // rolls outward, weapon tips to the right

// Weapon switch: quick lower, swap model at the bottom, raise back up
const SWITCH_LOWER_TIME = 0.12;
const SWITCH_RAISE_TIME = 0.16;
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
// Fist flight path (group-local space): off-screen bottom-left → jab center
const FIST_OFF = new THREE.Vector3(-0.42, -0.34, -0.5);
const FIST_JAB = new THREE.Vector3(-0.02, -0.14, -0.62);

export class ViewModel {
  readonly group: THREE.Group;
  // Keyed by WeaponType — the array order used to collide with the enum
  // (Chaingun=3 showed the mortar mesh, Railgun=9 indexed past the end).
  private weapons = new Map<number, THREE.Group>();
  // Muzzle Z per weapon (model space) so the flash sits AT the bore,
  // not at a fixed offset that floats ahead of stubby barrels.
  private static readonly MUZZLE_Z: Record<number, number> = {
    [WeaponType.Rocket]: -0.31, [WeaponType.Disc]: -0.20, [WeaponType.DiscPull]: -0.20,
    [WeaponType.Chaingun]: -0.36, [WeaponType.Mortar]: -0.28, [WeaponType.GrenadeLauncher]: -0.25,
    [WeaponType.Flak]: -0.28, [WeaponType.Plasma]: -0.28, [WeaponType.Railgun]: -0.43,
  };
  private chainBarrels: THREE.Group | null = null;
  private spinVel = 0;
  private static readonly SPIN_MAX = 40; // rad/s at full spin
  private activeWeapon = 0;
  private switchT = -1;
  private pendingWeapon = -1;
  private timer = 0;
  private kickAmount = 0;
  private kickX = 0;         // sideways kick — flak/melee shudder
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

  constructor(camera: THREE.PerspectiveCamera) {
    this.group = new THREE.Group();

    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x555a60, emissive: 0x1c1e20 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2d30, emissive: 0x0e0f10 });
    const boreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

    const mkTube = (r1: number, r2: number, len: number, z: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 8), mat);
      m.rotation.x = Math.PI / 2;
      m.position.z = z;
      return m;
    };
    const mkBore = (r: number, z: number) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 8), boreMat);
      m.position.z = z;
      return m;
    };

    // Weapon 0 — rocket launcher: one fat tube + muzzle ring
    const rocket = new THREE.Group();
    rocket.add(mkTube(0.11, 0.13, 0.55, 0, bodyMat));
    rocket.add(mkTube(0.14, 0.14, 0.08, -0.26, darkMat));
    rocket.add(mkBore(0.1, -0.301));

    // Weapon 1 — disc launcher: stubby wide tube with a flat disc face
    const disc = new THREE.Group();
    disc.add(mkTube(0.15, 0.16, 0.34, 0.02, bodyMat));
    disc.add(mkTube(0.17, 0.17, 0.05, -0.16, darkMat));
    const discFace = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 16), darkMat);
    discFace.rotation.x = Math.PI / 2;
    discFace.position.z = -0.19;
    disc.add(discFace);
    disc.visible = false;

    // Weapon 2 — chaingun: 3 thin barrels triangulated around center
    const chain = new THREE.Group();
    this.chainBarrels = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const barrel = mkTube(0.035, 0.035, 0.5, -0.1, bodyMat);
      barrel.position.x = Math.cos(a) * 0.06;
      barrel.position.y = Math.sin(a) * 0.06;
      this.chainBarrels.add(barrel);
    }
    chain.add(this.chainBarrels);
    chain.add(mkTube(0.09, 0.11, 0.28, 0.12, darkMat)); // receiver housing
    chain.visible = false;

    // Weapon 3 — mortar: fat short tube with a wide muzzle + rear base
    const mortar = new THREE.Group();
    mortar.add(mkTube(0.19, 0.16, 0.42, -0.02, darkMat));
    mortar.add(mkTube(0.22, 0.20, 0.1, -0.22, bodyMat)); // flared muzzle
    mortar.add(mkBore(0.17, -0.271));
    mortar.add(mkTube(0.1, 0.14, 0.14, 0.2, darkMat)); // breech
    mortar.visible = false;

    // Weapon 4 — grenade launcher: tube + drum cylinder on the side
    const gl = new THREE.Group();
    gl.add(mkTube(0.12, 0.12, 0.4, -0.04, bodyMat));
    gl.add(mkBore(0.1, -0.241));
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 12), darkMat);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0.13, -0.04, 0.06);
    gl.add(drum);
    gl.visible = false;

    // Weapon 5 — flak cannon: wide boxy breech + short ribbed barrel
    const flak = new THREE.Group();
    flak.add(mkTube(0.17, 0.15, 0.3, -0.08, bodyMat));
    flak.add(mkTube(0.19, 0.19, 0.06, -0.24, darkMat)); // muzzle ring
    flak.add(mkBore(0.15, -0.271));
    const flakBox = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.3), darkMat);
    flakBox.position.set(0, 0, 0.16);
    flak.add(flakBox);
    // Top vents — the UT flak "grill"
    for (let i = 0; i < 3; i++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), bodyMat);
      vent.position.set(0, 0.11, 0.08 + i * 0.08);
      flak.add(vent);
    }
    flak.visible = false;

    // Weapon 6 — plasma gun: twin slim tubes + glowing emitter ring
    const plasma = new THREE.Group();
    plasma.add(mkTube(0.09, 0.09, 0.45, -0.02, bodyMat));
    const sideTube = mkTube(0.04, 0.04, 0.35, -0.01, darkMat);
    sideTube.position.x = 0.09;
    plasma.add(sideTube);
    plasma.add(mkTube(0.11, 0.13, 0.06, -0.24, darkMat)); // emitter collar
    plasma.add(mkBore(0.08, -0.271));
    const plasmaGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.02, 16),
      new THREE.MeshBasicMaterial({ color: 0x33ffaa })
    );
    plasmaGlow.rotation.x = Math.PI / 2;
    plasmaGlow.position.z = -0.272;
    plasma.add(plasmaGlow);
    plasma.visible = false;

    // Weapon 7 — railgun: Q3's fat coil-cannon. Thick central bore, a stack
    // of fat accelerator coils ribbing the barrel, glowing muzzle ring.
    // The silhouette reads "industrial capacitor bank", not sniper rifle.
    const rail = new THREE.Group();
    // Fat bore — the barrel itself is the chunk
    rail.add(mkTube(0.13, 0.14, 0.55, -0.08, bodyMat));
    // Coil stack: fat rings ribbing the barrel — THE railgun read
    for (let i = 0; i < 4; i++) {
      const coil = mkTube(0.165, 0.165, 0.05, -0.3 + i * 0.14, darkMat);
      rail.add(coil);
      // Cyan energy slit between coils — the capacitor glow peeking through
      const glowRing = mkTube(0.15, 0.15, 0.02, -0.23 + i * 0.14,
        new THREE.MeshBasicMaterial({ color: 0x55bbff }));
      rail.add(glowRing);
    }
    // Flared muzzle + glow bore
    rail.add(mkTube(0.16, 0.18, 0.08, -0.38, darkMat));
    const muzzleGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.02, 16),
      new THREE.MeshBasicMaterial({ color: 0x66ccff })
    );
    muzzleGlow.rotation.x = Math.PI / 2;
    muzzleGlow.position.z = -0.421;
    rail.add(muzzleGlow);
    // Rear capacitor housing — big drum behind the receiver
    const capDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.16, 12), darkMat);
    capDrum.rotation.x = Math.PI / 2;
    capDrum.position.set(0, -0.02, 0.22);
    rail.add(capDrum);
    rail.visible = false;

    // Map is keyed by WeaponType, never positionally — Grenade/Slam/Melee
    // have no gun model (belt throw / fist), so they map to nothing.
    const models: [number, THREE.Group][] = [
      [WeaponType.Rocket, rocket],
      [WeaponType.Disc, disc],
      [WeaponType.DiscPull, disc],
      [WeaponType.Chaingun, chain],
      [WeaponType.Mortar, mortar],
      [WeaponType.GrenadeLauncher, gl],
      [WeaponType.Flak, flak],
      [WeaponType.Plasma, plasma],
      [WeaponType.Railgun, rail],
    ];
    for (const [wt, g] of models) { this.weapons.set(wt, g); this.group.add(g); }

    // Muzzle flash — single billboard quad at the bore, additive, ~70ms.
    // Random roll each shot keeps it from looking identical.
    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffc866,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), this.flashMat);
    this.flashMesh.position.set(0, 0, -0.42); // just past the bore
    this.flashMesh.visible = false;
    this.group.add(this.flashMesh);
    // Second quad at 45° — crossed pair reads as a star-burst, not a square
    this.flashMesh2 = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), this.flashMat);
    this.flashMesh2.position.set(0, 0, -0.42);
    this.flashMesh2.rotation.z = Math.PI / 4;
    this.flashMesh2.visible = false;
    this.group.add(this.flashMesh2);

    // Off-hand fist for melee — chunky glove: palm block + knuckle row.
    // Parked off-screen bottom-left until punch() jabs it across the frame.
    this.fistGroup = new THREE.Group();
    const gloveMat = new THREE.MeshLambertMaterial({ color: 0x3a3d42, emissive: 0x111214 });
    const knuckleMat = new THREE.MeshLambertMaterial({ color: 0x8a4a3a, emissive: 0x20100c });
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.14), gloveMat);
    this.fistGroup.add(palm);
    for (let i = 0; i < 4; i++) {
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.03, 0.03), knuckleMat);
      k.position.set(-0.036 + i * 0.024, 0.03, -0.07);
      this.fistGroup.add(k);
    }
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6), gloveMat);
    wrist.rotation.x = Math.PI / 2;
    wrist.position.set(0, -0.02, 0.11);
    this.fistGroup.add(wrist);
    this.fistGroup.position.copy(FIST_OFF);
    this.fistGroup.rotation.set(0.15, 0.25, -0.1);
    this.fistGroup.visible = false;
    this.group.add(this.fistGroup);

    // Bottom-right, mostly centered — Quake guns sit low and fat
    this.group.scale.setScalar(0.8);
    this.group.position.copy(REST_POS);
    this.group.rotation.y = 0.05;
    this.group.rotation.x = this.baseRotX;

    camera.add(this.group);
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
    [WeaponType.Plasma]:          [15, 0.00, 0x44ffbb, 0.5, 0.6],   // light tap, green glow
    [WeaponType.Railgun]:         [18, 0.01, 0x77ccff, 1.1, 0.9],   // fast snap, cyan discharge
  };

  kick(strength = 1): void {
    const t = ViewModel.KICK_TUNE[this.activeWeapon] ?? ViewModel.KICK_TUNE[WeaponType.Rocket];
    this.kickAmount = strength;
    this.kickDecay = t[0];
    this.kickX = (Math.random() - 0.5) * t[1];
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

  startThrow(): void {
    this.throwT = 0;
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

    // Fire kick — sharp push toward camera + muzzle rise, fast spring back.
    // Quake-style: decay the impulse, don't tween a position.
    this.kickAmount *= Math.exp(-dt * this.kickDecay);
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
    this.group.rotation.z = this.baseRotZ + totalDip * THROW_DIP_ROLL + punch * PUNCH_ROLL;

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
