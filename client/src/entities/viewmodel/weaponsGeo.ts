import * as THREE from 'three';
import { WeaponType } from '../../../../shared/weapons.js';
import { getMuzzleFlashTexture } from '../../effects/glowTexture.js';
import { mkPlasmaCannon, mkPlasmaGun, mkSprinkler, mkRailgun, mkLightningGun, mkShocklance } from './weaponsGeoEnergy.js';
import { mkPistol, mkRevolver, mkRepair } from './weaponsGeoSidearm.js';
import { mkBolt, mkDisc, mkChaingun, mkMortar, mkGrenadeLauncher, mkSticky, mkFlak, mkShotgun, mkCannon, mkRpg, mkMrv, mkBombard } from './weaponsGeoBallistic.js';
import { darkMat } from './weaponKit.js';

// Procedural weapon geometry — every viewmodel gun built from primitives.
// Extracted from ViewModel's constructor; returns the built maps so the
// class keeps no build-time locals. Energy weapons and sidearms live in
// their own builder files; this file keeps the ballistic launchers and
// the assembly table.
export interface WeaponMeshes {
  weapons: Map<number, THREE.Group>;
  muzzleNodes: Map<number, THREE.Object3D>;
  chainBarrels: THREE.Group;
}

export const MODEL_BUILDERS: [number, () => THREE.Group][] = [
  [WeaponType.BoltLauncher, mkBolt],
  [WeaponType.Disc, mkDisc],
  [WeaponType.GrenadeLauncher, mkGrenadeLauncher],
  [WeaponType.Flak, mkFlak],
  [WeaponType.Mortar, mkMortar],
  [WeaponType.PlasmaCannon, mkPlasmaCannon],
  [WeaponType.PlasmaGun, mkPlasmaGun],
  [WeaponType.Sprinkler, mkSprinkler],
  [WeaponType.Railgun, mkRailgun],
  [WeaponType.Lightning, mkLightningGun],
  [WeaponType.Shotgun, mkShotgun],
  [WeaponType.Cannon, mkCannon],
  [WeaponType.RocketLauncher, mkRpg],
  [WeaponType.Pistol, mkPistol],
  [WeaponType.Revolver, mkRevolver],
  [WeaponType.Sticky, mkSticky],
  [WeaponType.Repair, mkRepair],
  [WeaponType.MRVLauncher, mkMrv],
  [WeaponType.Bombard, mkBombard],
  [WeaponType.Shocklance, mkShocklance],
];

export function buildWeaponMeshes(parent: THREE.Group, muzzleZ: Record<number, number>): WeaponMeshes {
  const weapons = new Map<number, THREE.Group>();
  const muzzleNodes = new Map<number, THREE.Object3D>();
  // Chaingun needs its barrels group back; DiscPull reuses the Disc group —
  // neither can live in the plain builder table.
  const chain = mkChaingun();
  const models: [number, THREE.Group][] = MODEL_BUILDERS.map(([wt, mk]): [number, THREE.Group<THREE.Object3DEventMap>] => [wt, mk()]);
  models.push([WeaponType.Chaingun, chain.g]);
  for (const [wt, g] of models) {
    weapons.set(wt, g);
    parent.add(g);
    const mz = new THREE.Object3D();
    // muzzleZ is GROUP-space (the flash parks on it raw) — divide out the
    // model scale so the node lands on the same group-space z.
    mz.position.z = (muzzleZ[wt] ?? -0.35) / g.scale.z;
    // Chaingun fires from the TOP barrel — the cluster indexes a barrel
    // to TDC each shot, so the flash rides the top of the cluster.
    if (wt === WeaponType.Chaingun) {mz.position.y = 0.088;}
    g.add(mz);
    muzzleNodes.set(wt, mz);
  }
  weapons.set(WeaponType.DiscPull, weapons.get(WeaponType.Disc)!);
  const pullMz = new THREE.Object3D();
  pullMz.position.z = muzzleZ[WeaponType.DiscPull] ?? -0.35;
  weapons.get(WeaponType.Disc)!.add(pullMz);
  muzzleNodes.set(WeaponType.DiscPull, pullMz);
  return { weapons, muzzleNodes, chainBarrels: chain.barrels };
}

export interface HandFlash {
  fistGroup: THREE.Group;
  hammerGroup: THREE.Group;
  flashMat: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMesh2: THREE.Mesh;
}

// Fist flight path (group-local space): off-screen bottom-left → jab center
export const FIST_OFF = new THREE.Vector3(-0.42, -0.34, -0.5);
export const FIST_JAB = new THREE.Vector3(-0.02, -0.14, -0.62);
// Rest pose — the punch env sweeps rotation.z through the chop and must
// know where to land back.
export const FIST_ROT = new THREE.Euler(0.15, 0.25, -0.1);

// Warhammer swing path (viewmodel-group space). The HANDLE leads: the
// grip sweeps right→left across the frame and the head DRAGS behind it
// (overlapping action), then whips into the contact a beat later. That
// lag is what makes a rigid prop read as a swing instead of a slide —
// the head arrives at the crosshair last, and it is arriving fast.
//
// The entry is handle-first: the grip sits close to the camera in the
// lower right with the head still off-frame, so the swing comes in from
// the right the way a hand sweeps across the view.
//
// Euler is (pitch, yaw, roll) with the head on the local -Z: pitch
// positive lifts the head (it hangs above the grip), yaw negative puts
// it right of the hand.
export const HAMMER_ENTER = new THREE.Vector3(0.05, 0.00, -0.01);
export const HAMMER_COCK = new THREE.Vector3(0.01, 0.02, 0.03);
export const HAMMER_CONTACT = new THREE.Vector3(-0.15, 0.10, -0.07);
export const HAMMER_EXIT = new THREE.Vector3(-0.33, -0.02, -0.05);
export const HAMMER_ROT_ENTER = new THREE.Euler(0.62, -0.75, 0.20);
export const HAMMER_ROT_COCK = new THREE.Euler(0.81, -0.38, 0.10);
export const HAMMER_ROT_CONTACT = new THREE.Euler(0.22, 0.32, -0.25);
export const HAMMER_ROT_EXIT = new THREE.Euler(-0.41, 0.85, -0.55);

export function buildHandAndFlash(parent: THREE.Group): HandFlash {
// Muzzle flash — single billboard quad at the bore, additive, ~70ms.
// Random roll each shot keeps it from looking identical.
const flashMat = new THREE.MeshBasicMaterial({
  map: getMuzzleFlashTexture(), // starburst alpha — kills the square edge
  color: 0xFF_C8_66,
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
flashMesh.position.set(0, 0, -0.42); // just past the bore
flashMesh.visible = false;
parent.add(flashMesh);
// Second quad at 45° — crossed pair reads as a star-burst, not a square
const flashMesh2 = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
flashMesh2.position.set(0, 0, -0.42);
flashMesh2.rotation.z = Math.PI / 4;
flashMesh2.visible = false;
parent.add(flashMesh2);

// Off-hand fist for melee — chunky glove: palm block + knuckle row.
// Parked off-screen bottom-left until punch() jabs it across the frame.
const fistGroup = new THREE.Group();
const gloveMat = new THREE.MeshLambertMaterial({ color: 0x3A_3D_42, emissive: 0x11_12_14 });
const knuckleMat = new THREE.MeshLambertMaterial({ color: 0x8A_4A_3A, emissive: 0x20_10_0C });
const palm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.14), gloveMat);
fistGroup.add(palm);
for (let i = 0; i < 4; i += 1) {
  const k = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.03, 0.03), knuckleMat);
  k.position.set(-0.036 + i * 0.024, 0.03, -0.07);
  fistGroup.add(k);
}
const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6), gloveMat);
wrist.rotation.x = Math.PI / 2;
wrist.position.set(0, -0.02, 0.11);
fistGroup.add(wrist);
fistGroup.position.copy(FIST_OFF);
fistGroup.rotation.copy(FIST_ROT);
fistGroup.visible = false;
parent.add(fistGroup);

// Warhammer — the melee swing prop. Sized for the SCREEN, not for a
// real workshop: at true scale (8cm head, 14mm haft) it read as a
// stick flying around the view, so the head is chunky and the haft
// short — the head leads the swing, the haft trails it. The group
// origin is the GRIP: the swing env flies it through the staged
// HAMMER_* poses and it owns the frame (the gun is holstered).
const woodMat = new THREE.MeshLambertMaterial({ color: 0x5A_3C_24 });
const steelMat = new THREE.MeshLambertMaterial({ color: 0xC8_D0_D8, emissive: 0x2A_2E_33 });
const hammerGroup = new THREE.Group();
// Haft — 38cm of oak, tapering toward the head. Deliberately short: the
// head is the thing the eye tracks, and a long lever throws it out of
// frame at the top of the swing.
const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.034, 0.38, 8), woodMat);
haft.rotation.x = Math.PI / 2;
haft.position.z = -0.16;
hammerGroup.add(haft);
// Leather grip wrap — reads as the hand end of the haft.
const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.12, 8), knuckleMat);
wrap.rotation.x = Math.PI / 2;
wrap.position.z = -0.03;
hammerGroup.add(wrap);
// Steel langet running from the haft up into the head.
const langet = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.16), steelMat);
langet.position.z = -0.32;
hammerGroup.add(langet);
// The head — the whole point of the prop. 26cm across, ~15% of the
// frame width at the cock.
const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.3), steelMat);
head.position.z = -0.44;
hammerGroup.add(head);
// Striking face — darker, slightly proud of the head.
const face = new THREE.Mesh(new THREE.BoxGeometry(0.275, 0.215, 0.04), darkMat);
face.position.z = -0.605;
hammerGroup.add(face);
// Rear peen + top spike — the warhammer silhouette.
const peen = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.14, 0.12), darkMat);
peen.position.z = -0.25;
hammerGroup.add(peen);
const spike = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.16, 6), steelMat);
spike.position.set(0, 0.16, -0.44);
hammerGroup.add(spike);
const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), steelMat);
pommel.position.z = 0.05;
hammerGroup.add(pommel);
hammerGroup.position.copy(HAMMER_ENTER);
hammerGroup.rotation.copy(HAMMER_ROT_ENTER);
hammerGroup.visible = false;
parent.add(hammerGroup);
  return { fistGroup, hammerGroup, flashMat, flashMesh, flashMesh2 };
}
