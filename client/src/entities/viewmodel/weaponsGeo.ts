import * as THREE from 'three';
import { WeaponType } from '../../../../shared/weapons.js';
import { getMuzzleFlashTexture } from '../../effects/glowTexture.js';
import { mkPlasmaCannon, mkPlasmaGun, mkRailgun, mkLightningGun } from './weaponsGeoEnergy.js';
import { mkPistol, mkRevolver, mkRepair } from './weaponsGeoSidearm.js';
import { mkRocket, mkDisc, mkChaingun, mkMortar, mkGrenadeLauncher, mkSticky, mkFlak, mkShotgun, mkCannon, mkRpg } from './weaponsGeoBallistic.js';

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

const MODEL_BUILDERS: [number, () => THREE.Group][] = [
  [WeaponType.Rocket, mkRocket],
  [WeaponType.Disc, mkDisc],
  [WeaponType.GrenadeLauncher, mkGrenadeLauncher],
  [WeaponType.Flak, mkFlak],
  [WeaponType.Mortar, mkMortar],
  [WeaponType.PlasmaCannon, mkPlasmaCannon],
  [WeaponType.PlasmaGun, mkPlasmaGun],
  [WeaponType.Sprinkler, mkPlasmaGun], // same receiver, different bolt payload
  [WeaponType.Railgun, mkRailgun],
  [WeaponType.Lightning, mkLightningGun],
  [WeaponType.Shotgun, mkShotgun],
  [WeaponType.Cannon, mkCannon],
  [WeaponType.RocketLauncher, mkRpg],
  [WeaponType.Pistol, mkPistol],
  [WeaponType.Revolver, mkRevolver],
  [WeaponType.Sticky, mkSticky],
  [WeaponType.Repair, mkRepair],
];

export function buildWeaponMeshes(parent: THREE.Group, muzzleZ: Record<number, number>): WeaponMeshes {
  const weapons = new Map<number, THREE.Group>();
  const muzzleNodes = new Map<number, THREE.Object3D>();
  // Chaingun needs its barrels group back; DiscPull reuses the Disc group —
  // neither can live in the plain builder table.
  const chain = mkChaingun();
  const models: [number, THREE.Group][] = MODEL_BUILDERS.map(([wt, mk]) => [wt, mk()]);
  models.push([WeaponType.Chaingun, chain.g]);
  for (const [wt, g] of models) {
    weapons.set(wt, g);
    parent.add(g);
    const mz = new THREE.Object3D();
    mz.position.z = muzzleZ[wt] ?? -0.35;
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
  flashMat: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMesh2: THREE.Mesh;
}

// Fist flight path (group-local space): off-screen bottom-left → jab center
export const FIST_OFF = new THREE.Vector3(-0.42, -0.34, -0.5);
export const FIST_JAB = new THREE.Vector3(-0.02, -0.14, -0.62);

export function buildHandAndFlash(parent: THREE.Group): HandFlash {
// Muzzle flash — single billboard quad at the bore, additive, ~70ms.
// Random roll each shot keeps it from looking identical.
const flashMat = new THREE.MeshBasicMaterial({
  map: getMuzzleFlashTexture(), // starburst alpha — kills the square edge
  color: 0xffc866,
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
const gloveMat = new THREE.MeshLambertMaterial({ color: 0x3a3d42, emissive: 0x111214 });
const knuckleMat = new THREE.MeshLambertMaterial({ color: 0x8a4a3a, emissive: 0x20100c });
const palm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.14), gloveMat);
fistGroup.add(palm);
for (let i = 0; i < 4; i++) {
  const k = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.03, 0.03), knuckleMat);
  k.position.set(-0.036 + i * 0.024, 0.03, -0.07);
  fistGroup.add(k);
}
const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6), gloveMat);
wrist.rotation.x = Math.PI / 2;
wrist.position.set(0, -0.02, 0.11);
fistGroup.add(wrist);
fistGroup.position.copy(FIST_OFF);
fistGroup.rotation.set(0.15, 0.25, -0.1);
fistGroup.visible = false;
parent.add(fistGroup);
  return { fistGroup, flashMat, flashMesh, flashMesh2 };
}
