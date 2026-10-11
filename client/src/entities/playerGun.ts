// The third-person hand prop — one merged geometry + shared material per
// remote (two meshes used to cost a draw call apiece). Owns the gun
// group, its mount (hand-bone per-axis / palm-line / world-frame /
// model-root socket), the per-frame bone-follow, and the baked-weapon
// geo swap. PlayerModel keeps thin delegates so ModelFx's host surface
// and external callers (muzzle anchor, debug tuning) are unchanged.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { ChildLogger } from '../core/Logger.js';
import { ModelFx } from './modelFx.js';
import { handWeaponGeo } from './handWeapons.js';
import type { RigManifest } from './playerClips.js';

const logger = new ChildLogger('PlayerGun');

const _gunV = new THREE.Vector3();
const _gunQ = new THREE.Quaternion();
const _gunMQ = new THREE.Quaternion();
const _gunPalmL = new THREE.Vector3();
const _gunDir = new THREE.Vector3();
const _gunUp = new THREE.Vector3(0, 1, 0);
const _gunLook = new THREE.Matrix4();
const _gunQ2 = new THREE.Quaternion();
const _gunQYaw = new THREE.Quaternion();

type RigMount = NonNullable<RigManifest['mount']>;

export interface GunAttachArgs {
  /** Resolved bone the prop parents to (mount.bone ?? hand bone). */
  handBone: THREE.Bone | null;
  handBoneL: THREE.Bone | null;
  mount?: RigMount;
  model: THREE.Object3D;
  modelScale: number;
  feetOffsetY: number;
  classGun?: [number, number, number];
}

export class PlayerGun {
  /** The baked-geo swap also invalidates the model's wireframe capture —
   *  PlayerModel sets this once. */
  onGeoSwap: (() => void) | null = null;

  group: THREE.Group | null = null;
  mesh: THREE.Mesh | null = null;
  muzzleFlash: THREE.Sprite | null = null;
  // Weapon switches fire before the GLB loads (spawn loadout races the
  // async mesh) — the pick stashes here so attach's tail can re-apply it
  // the moment a mount exists instead of dropping it.
  heldWeapon = -1;
  // Base transform the fx envelopes (kick/swap/throw/punch) compose on —
  // ModelFx reads these through the host surface each frame.
  unit = 1; // 1 world meter in bone-space units
  baseY = 0;
  baseZ = 0;
  restX = 0; // socket-mounted guns park at a lateral offset
  baseX = 0; // mannequin attach pitch — recoil adds on top
  kickZ = 0;
  baseQuat: THREE.Quaternion | null = null;
  size = 0.7;
  // Bone-mounted gun: world scale is renormalized every follow — rigs
  // like polyart carry non-uniform armature scale that shifts with the
  // pose, so a one-time per-axis divide still let the prop stretch
  // needle-thin (the "sword" gun).
  mountBone: THREE.Object3D | null = null;
  mountPos: [number, number, number] = [0, 0, 0];
  mountQuat: THREE.Quaternion | null = null;
  palms = false;
  palmFwd = 0;
  palmFlip = false;
  palmYaw = 0;
  palmUp = 0;

  private static geo: THREE.BufferGeometry | null = null;
  private static mat: THREE.MeshStandardMaterial | null = null;

  private static shared(): void {
    if (!PlayerGun.mat) {
      PlayerGun.mat = new THREE.MeshStandardMaterial({ color: 0x2A_2E_33, roughness: 0.55, metalness: 0.6, emissive: 0x33_44_55, emissiveIntensity: 0.8 });
    }
    if (!PlayerGun.geo) {
      const body = new THREE.BoxGeometry(0.16, 0.26, 0.9);
      body.translate(0, 0, 0.25);
      const barrel = new THREE.CylinderGeometry(0.05, 0.05, 0.55);
      barrel.rotateX(Math.PI / 2);
      barrel.translate(0, 0.05, 0.75);
      PlayerGun.geo = mergeGeometries([body, barrel], false)!;
      body.dispose(); barrel.dispose();
    }
  }

  /** Procedural gun in the right hand — follows every animation.
   *  Bone-mounted on rigs whose bones match the rendered body
   *  (mannequin/robot), socket-mounted on class bodies whose armature
   *  frames don't (cyber's bones sit ~98 units off). */
  attach(a: GunAttachArgs): void {
    const { model, modelScale, classGun } = a;
    PlayerGun.shared();
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(PlayerGun.geo!, PlayerGun.mat!);
    this.group.add(this.mesh);
    // Measure bone world scale AFTER model.scale so the gun lands
    // real-world size (bones carry the armature's ~100x scale)
    model.updateMatrixWorld(true);
    if (!a.handBone && classGun) {
      // Socket fallback: class bodies keep bones in armature frames up to
      // ~100 units off the rendered mesh (cyber's hips bind at -98Z), so
      // rigs that never captured a hand bone park the gun on the model
      // root at the per-variant socket instead.
      const ws = modelScale;
      this.group.scale.setScalar(0.7 / ws);
      this.unit = 1 / ws;
      this.kickZ = 0.15 * this.unit;
      // gunLocal is meters above the logical feet; the model root sits
      // feetOffsetY below them on rigs not authored feet-at-origin. The
      // FX update rewrites group.position from these base fields each
      // frame, so the socket lives in the bases, not a one-time set.
      this.restX = classGun[0] * this.unit;
      this.baseY = (classGun[1] - a.feetOffsetY) * this.unit;
      this.baseZ = classGun[2] * this.unit;
      this.group.position.set(this.restX, this.baseY, this.baseZ);
      this.group.rotation.y = Math.PI; // barrel -Z = the body's facing
      this.muzzleFlash = ModelFx.buildMuzzleFlash();
      this.group.add(this.muzzleFlash);
      model.add(this.group);
      if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
      return;
    }
    const handBone = a.handBone!;
    const ws = handBone.getWorldScale(new THREE.Vector3());
    const {mount} = a;
    logger.debug(`GUN ATTACH`, { hand: handBone.name, worldScale: ws.x });
    if (mount?.palms && a.handBoneL && model) {
      // Palm-line mount: model-root prop driven per frame — position at
      // the grip palm, +Z along grip→foregrip. No authored quat: the
      // palm line IS the barrel axis the clip intends, so it survives
      // every clip's differing hand basis.
      this.palms = true;
      this.palmFwd = mount.palmFwd ?? 0;
      this.palmFlip = Boolean(mount.palmsFlip);
      this.palmYaw = mount.palmYaw ?? 0;
      this.palmUp = mount.palmUp ?? 0;
      this.mountPos = mount.pos ?? [0, 0, 0];
      this.mountOnModel(handBone, mount, model, modelScale);
      return;
    }
    if (mount?.world && model) {
      // World-frame mount: the prop parents to the model root and tracks
      // the bone's world transform in follow() — rigs with rotated
      // non-uniform armature scale shear a bone-parented prop into a
      // needle, which no per-axis scale compensation can undo.
      this.mountPos = mount.pos ?? [0, 0, 0];
      this.mountQuat = mount.quat ? new THREE.Quaternion(mount.quat[0], mount.quat[1], mount.quat[2], mount.quat[3]) : new THREE.Quaternion();
      this.mountOnModel(handBone, mount, model, modelScale);
      return;
    }
    // Per-axis: some rigs (polyart) carry non-uniform bone scale that
    // squeezes the prop into a needle when only ws.x is compensated.
    const gunSize = mount?.size ?? 0.7;
    this.size = gunSize;
    this.group.scale.set(gunSize / ws.x, gunSize / ws.y, gunSize / ws.z);
    if (mount?.fat) {this.mesh!.scale.set(mount.fat, mount.fat, 1);}
    this.baseZ = 0.05 / ws.x;
    this.kickZ = 0.15 / ws.x; // recoil distance in bone units
    this.unit = 1 / ws.x;
    this.baseY = 0.05 * this.unit;
    if (mount?.pos) {
      this.restX = mount.pos[0];
      this.baseY = mount.pos[1];
      this.baseZ = mount.pos[2];
    }
    this.group.position.set(this.restX, this.baseY, this.baseZ);
    // Orientation comes from the manifest: euler rigs (mannequin) roll
    // recoil through baseX; quat rigs write baseQuat so fx
    // envelopes compose on top instead of stomping rotation.x/z.
    // Palm axes differ per rig family — quats were solved per rig on the
    // posedump loop, tune via debugSetGunRot.
    if (mount?.euler) {
      this.group.rotation.set(mount.euler[0], mount.euler[1], mount.euler[2]);
      // Same bone-frame trap as the position kick: rotation.x on an euler
      // mount is arbitrary in bone space, so the fx pitch delta swung the
      // gun sideways. Stash the rest orientation as a quat — the fx path
      // then composes deltas in the gun's own frame (muzzle-up pitch).
      this.baseQuat = this.group.quaternion.clone();
    } else if (mount?.quat) {
      this.baseQuat = new THREE.Quaternion(mount.quat[0], mount.quat[1], mount.quat[2], mount.quat[3]);
      this.group.quaternion.copy(this.baseQuat);
    } else {
      this.group.rotation.y = Math.PI;
    }

    // Muzzle flash: additive sprite at the barrel tip, flashed on
    // fire() and faded in update(). Cheap (one sprite per remote),
    // blooms nicely at distance — this is what makes remote fire
    // readable when tracking small targets in the sky.
    this.muzzleFlash = ModelFx.buildMuzzleFlash();
    this.group.add(this.muzzleFlash);

    handBone.add(this.group);
    if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
  }

  // Model-root mount tail shared by the palms/world branches — the prop
  // lives under the model, not the hand bone, so uniform modelScale is
  // the only scale compensation needed.
  private mountOnModel(bone: THREE.Object3D | null, mount: RigMount, model: THREE.Object3D, modelScale: number): void {
    this.mountBone = bone;
    this.size = mount.size ?? 0.7;
    this.unit = 1 / modelScale;
    this.kickZ = 0.15 * this.unit;
    this.baseQuat = new THREE.Quaternion();
    this.group!.scale.setScalar(this.size / modelScale);
    this.muzzleFlash = ModelFx.buildMuzzleFlash();
    this.group!.add(this.muzzleFlash);
    model.add(this.group!);
    if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
  }

  /** Per-frame bone follow for the model-root mounts — rewrites the fx
   *  base fields from the bone's live world transform so tickGunFx
   *  composes kick/swap/throw deltas on top of these. */
  follow(dt: number, model: THREE.Object3D | null, modelScale: number, handBoneL: THREE.Bone | null): void {
    if (!this.mountBone || !this.group || !model) {return;}
    const mb = this.mountBone;
    mb.updateWorldMatrix(true, false);
    mb.localToWorld(_gunV.set(this.mountPos[0], this.mountPos[1], this.mountPos[2]));
    model.worldToLocal(_gunV);
    this.restX = _gunV.x; this.baseY = _gunV.y; this.baseZ = _gunV.z;
    if (this.palms && handBoneL) {
      // Palm-line mount: the barrel axis is right-palm → left-palm.
      // Degenerate (hands split for a one-hand clip) → keep the palm
      // seat but aim model-forward (-Z) instead of a garbage line.
      handBoneL.getWorldPosition(_gunPalmL);
      model.worldToLocal(_gunPalmL);
      _gunDir.subVectors(_gunPalmL, _gunV);
      const len = _gunDir.length();
      if (len > 0.03) {_gunDir.divideScalar(len);} else {_gunDir.set(0, 0, -1);}
      // |z| guard: hand-splits (one-hand clips) give lateral axes —
      // fall back to model forward. Either z sign is valid: rigs grip
      // both handednesses (polyart's palm line runs +Z).
      if (Math.abs(_gunDir.z) < 0.15) {_gunDir.set(0, 0, -1);}
      if (this.palmFlip) {_gunDir.negate();}
      // Seat offset along the barrel — right-palm seat alone reads too
      // far back on two-hand holds (polyart's marine grip).
      if (this.palmFwd || this.palmUp) {
        _gunV.addScaledVector(_gunDir, this.palmFwd);
        _gunV.y += this.palmUp;
        this.restX = _gunV.x; this.baseY = _gunV.y; this.baseZ = _gunV.z;
      }
      // lookAt maps -Z to eye→target; eye=left palm, target=right →
      // +Z = grip→foregrip = barrel dir. Slerp so clip jitter and
      // state pops don't buzz the muzzle.
      if (this.palmFlip) {_gunLook.lookAt(_gunV, _gunPalmL, _gunUp);}
      else {_gunLook.lookAt(_gunPalmL, _gunV, _gunUp);}
      _gunQ2.setFromRotationMatrix(_gunLook);
      if (this.palmYaw) {_gunQ2.premultiply(_gunQYaw.setFromAxisAngle(_gunUp, this.palmYaw));}
      this.baseQuat!.slerp(_gunQ2, Math.min(dt * 14, 1));
    } else {
      mb.getWorldQuaternion(_gunQ);
      model.getWorldQuaternion(_gunMQ).invert();
      this.baseQuat!.copy(_gunMQ).multiply(_gunQ).multiply(this.mountQuat!);
    }
    this.group.scale.setScalar(this.size / modelScale);
  }

  /** Barrel-tip world point — third-person beam/tracer anchor. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.muzzleFlash) {return false;}
    this.muzzleFlash.getWorldPosition(out);
    return true;
  }

  /** Live-tune the hand-bone mount rotation (posedump loop) — deg euler. */
  setRotDeg(x: number, y: number, z: number): void {
    this.group?.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
  }

  /** Swap the hand prop to the real weapon's silhouette. The wire only
   *  reveals a remote's weapon when they use it (playerShot/kill feed),
   *  so types without a baked model — or not yet seen firing — keep the
   *  generic prop rather than guess wrong. */
  setWeapon(wt: number): void {
    this.heldWeapon = wt;
    if (!this.mesh) {return;}
    const hit = handWeaponGeo(wt);
    const geo = hit?.geo ?? PlayerGun.geo!;
    if (this.mesh.geometry !== geo) {
      this.mesh.geometry = geo;
      // Baked models carry their own per-part materials; the generic prop
      // keeps its shared grey. The cached mats ARE the viewmodel's shared
      // palette (bodyMat/darkMat) — assigned raw because setGhost swaps
      // material references instead of mutating them, so a shimmer can't
      // leak into other models. Sharing also skips r184's clone() cost:
      // Material.copy runs a full toJSON on textured mats (PNG-encodes
      // every map), which profiled at ~20% of the frame during a fight.
      this.mesh.material = hit ? hit.mats : PlayerGun.mat!;
      this.onGeoSwap?.();
      // Flash rides the baked model's real muzzle, not a fixed offset —
      // each baked geo already carries its bounding box from the baker.
      if (this.muzzleFlash && geo.boundingBox) {
        this.muzzleFlash.position.set(0, 0.05, geo.boundingBox.max.z + 0.08);
      }
    }
  }
}
