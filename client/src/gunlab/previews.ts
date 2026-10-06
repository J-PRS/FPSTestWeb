// gunlab previews — creature, pickup, and deployable builders for the
// lab rail. Creature previews are a REAL species instance, not a mesh
// copy: the lab gets a flat-terrain stub + the actual SpeciesSwarm, so
// the preview IS the in-game instanced renderer (writeInstances pose,
// instanceColor tints, TerrainFoot skirt, blob shadow, head tracking
// the camera). The returned Group is a proxy — the body draws through
// the swarm's InstancedMeshes in the lab scene; an invisible bounds box
// gives inspect's Box3 fit something to frame.
import * as THREE from 'three';
import { initSwarms, type LabEntity } from '../entities/swarms.js';
import { AmbientBirds } from '../effects/birds.js';
import { DeployTurret } from '../entities/DeployTurret.js';
import { DeployShield } from '../entities/DeployShield.js';
import { DeployStation } from '../entities/DeployStation.js';
import { DeployBeacon } from '../entities/DeployBeacon.js';
import { DeployDrone } from '../entities/DeployDrone.js';
import { SWARM_SPECS } from '../game/species/registry.js';
import type { Terrain } from '../world/terrain.js';
import { PICKUP_ACCENT, pickupParts } from '../entities/PickupModel.js';
import { metalMat } from '../entities/procMetal.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { EMIT_GAIN } from '../core/config.js';
import type { PickupKind } from '../../../shared/pickups.js';
import { mkFlagPlate } from '../game/flagRun.js';
import { mkFlagMesh } from '../game/ctfFlags.js';
import { TEAM_COLORS } from '../../../shared/teams.js';
import { PlayerModel, type PlayerModelVariant } from '../entities/PlayerModel.js';
import { CLASS_BODY_VARIANT, type AnimationState } from '../entities/playerClips.js';
import { classCapsule, type ArmorClass } from '../../../shared/botClasses.js';

// The one live-body tick — whichever preview proxy is parked owns it.
// gunlab's render loop reads it through this holder so proxy builders
// can install/clear it without reaching into the main module.
export const previewLive: { tick: ((dt: number) => void) | null } = { tick: null };

// Camera world position is what creature AI and deployable tracking
// aim at — installed once by initPreviews since the tables below are
// built lazily, possibly before a camera exists.
let cam: THREE.Camera;
export function initPreviews(camera: THREE.Camera): void { cam = camera; }

const _camW = new THREE.Vector3();
const _zero = new THREE.Vector3();
let swarmsReady = false;
// All instanced creature rendering parents under ONE layer — swarm
// InstancedMeshes, blob shadows, bolt meshes, TerrainFoot, trail dots.
// Whichever proxy currently owns the layer owns the creature, so inspect
// recentring and FPS placement carry the real body instead of leaving it
// parked at world origin inside the camera.
const creatureLayer = new THREE.Group();
const LAB_SCENE = creatureLayer as unknown as THREE.Scene;
const LAB_TERRAIN = {
  getHeight: () => 0,
  getHeightVisual: () => 0,
  getNormal: () => new THREE.Vector3(0, 1, 0),
  // Decal APIs the deployables call when seating — a real handle object
  // so intensity tweens still land somewhere; there's just no clipmap
  // shader on the other end.
  addFieldRing: (x: number, z: number, r: number, tint: readonly number[]) => ({ x, z, r, intensity: 0.5, tint }),
  removeFieldRing: () => undefined,
  addScorch: () => null,
  addSplat: () => null,
} as unknown as Terrain;

function ensureSwarms(): void {
  if (swarmsReady) {return;}
  // The full live registry, shrunk to single-specimen buffers — a new
  // species shows up in the lab the moment it's registered, no lab edit.
  const labSpecs = Object.fromEntries(
    Object.entries(SWARM_SPECS).map(([k, s]) => [k, { ...s, capacity: 8 }]),
  );
  initSwarms(LAB_SCENE, LAB_TERRAIN, labSpecs);
  swarmsReady = true;
}

function creatureProxy(spawn: () => LabEntity): THREE.Group {
  ensureSwarms();
  const c = spawn();
  const proxy = new THREE.Group();
  // Invisible bounds sized off the entity's gameplay radius — gives
  // inspect's Box3 fit something sane to frame for overlord or gnat alike.
  const r = Math.max(c.radius, 0.4);
  const bounds = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, r * 2.2, r * 2.6), new THREE.MeshBasicMaterial());
  bounds.visible = false;
  bounds.position.y = r * 0.9;
  proxy.add(bounds, creatureLayer);
  // Live-body anchor — the swarm's instances sit wherever the creature
  // crawled, so the invisible bounds box can't be trusted to frame it.
  proxy.userData.liveFocus = () => c.pos;
  // Explicit dispose, NOT a 'removed' listener — inspect re-parents this
  // proxy (vm.group → scene) and 'removed' fires on every reparent,
  // which would slaughter the creature on each mode toggle.
  proxy.userData.disposeCreature = () => { c.dispose(); previewLive.tick = null; };
  // Feed playerPos in PROXY space, not world space: inspect mode
  // recentres/rotates the proxy, so a world-space camera pos would leave
  // the AI aiming at a phantom — the barrel misses you by exactly the
  // recentre offset. Local space keeps aim honest under any placement.
  previewLive.tick = (dt) => {
    proxy.updateMatrixWorld();
    c.update(dt, LAB_TERRAIN, proxy.worldToLocal(cam.getWorldPosition(_camW)));
  };
  return proxy;
}

// Every species that can spawn under the shared ctor is a lab button —
// plus the ambient buzzard kettle, a whole boid system rather than one
// species instance (shrunk to lab scale or it orbits past the horizon).
export const CREATURES: [label: string, build: () => THREE.Group][] = [
  ...Object.entries(SWARM_SPECS)
    .filter(([, s]) => s.spawn)
    .map(([name, s]): [string, () => THREE.Group] =>
      [name, () => creatureProxy(() => s.spawn!(LAB_SCENE, LAB_TERRAIN, new THREE.Vector3()))]),
  ['buzzard', () => creatureProxy(() => {
    const kettle = new AmbientBirds(LAB_SCENE, 0.08);
    return {
      pos: kettle.birds[0]!.group.position, radius: 2.5,
      update: (dt, _t, p) => kettle.update(dt, p, LAB_TERRAIN),
      dispose: () => kettle.dispose(),
    };
  })],
];

// Pickup previews — every kind is the same tumbling gem body (mesh +
// additive halo sprite) sold by its PICKUP_ACCENT tint, so the table
// builds straight off that map: new kinds appear here automatically.
const NUGGET_R = 0.3; // Nugget.ts NUGGET_RADIUS — keep in step
function buildNugget(kind: PickupKind): () => THREE.Group {
  return () => {
    const g = new THREE.Group();
    const base = new THREE.Color(PICKUP_ACCENT[kind]);
    const emit = base.clone().lerp(new THREE.Color(0xFFFFFF), 0.33).multiplyScalar(EMIT_GAIN);
    // Diegetic kinds get the real pickupParts body+accent — the same
    // shapes/materials Nugget builds in-game. Null parts keep the plain
    // gem (gem kind itself).
    const parts = pickupParts(kind);
    let gem: THREE.Mesh;
    if (parts) {
      gem = new THREE.Mesh(parts.body, metalMat(parts.bodyColor));
      gem.add(new THREE.Mesh(parts.accent, new THREE.MeshBasicMaterial({ color: emit })));
    } else {
      gem = new THREE.Mesh(
        new THREE.IcosahedronGeometry(NUGGET_R, 0),
        new THREE.MeshBasicMaterial({ color: emit }),
      );
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(32),
      color: base.clone().multiplyScalar(EMIT_GAIN),
      transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(1.1);
    g.add(gem, halo);
    // Glow-behind trick: the billboard is coplanar with the model's
    // center, so wherever the surface falls behind that plane the sprite
    // crops the silhouette. Each frame park it just past the body on the
    // far side of the camera (proxy-local space — inspect recentres and
    // rotates the proxy, so a world-space offset would drift).
    previewLive.tick = () => {
      g.updateMatrixWorld();
      const local = g.worldToLocal(cam.getWorldPosition(_camW));
      halo.position.copy(local.normalize().multiplyScalar(-0.25));
    };
    g.userData.disposeCreature = () => { previewLive.tick = null; };
    return g;
  };
}
export const PICKUPS: [label: string, build: () => THREE.Group][] =
  (Object.keys(PICKUP_ACCENT) as PickupKind[]).map((k) => [k, buildNugget(k)]);

// Deployable previews — real entity instances (real .group, real update
// loop) parked on the lab terrain stub. The group's own bounds feed
// inspect's Box3 fit, so no invisible proxy mesh is needed.
interface LabItem {
  group: THREE.Group;
  update?: (dt: number, p: THREE.Vector3) => void;
  dispose: (scene: THREE.Scene) => void;
}
function itemProxy(spawn: () => LabItem): THREE.Group {
  const it = spawn();
  const proxy = new THREE.Group();
  proxy.add(it.group);
  proxy.userData.liveFocus = () => it.group.getWorldPosition(new THREE.Vector3());
  proxy.userData.disposeCreature = () => { it.dispose(LAB_SCENE); previewLive.tick = null; };
  if (it.update) {
    previewLive.tick = (dt) => {
      proxy.updateMatrixWorld();
      it.update!(dt, proxy.worldToLocal(cam.getWorldPosition(_camW)));
    };
  }
  return proxy;
}
export const ITEMS: [label: string, build: () => THREE.Group][] = [
  // Flag on its floor plate — the flagrun pad + the shared flag mesh,
  // the in-game pair previewed as one piece — plus each half alone.
  ['flag', () => {
    const g = new THREE.Group();
    g.add(mkFlagPlate(TEAM_COLORS.alpha));
    const flag = mkFlagMesh('alpha');
    flag.position.y = 0.46; // pole inserts into the socket mouth
    g.add(flag);
    return g;
  }],
  ['flag alone', () => mkFlagMesh('alpha')],
  ['stand',     () => mkFlagPlate(TEAM_COLORS.alpha)],
  ['sentry',  () => itemProxy(() => { const d = new DeployTurret(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt) => d.update(dt, []), dispose: (s) => d.dispose(s) }; })],
  ['shield',  () => itemProxy(() => { const d = new DeployShield(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt) => d.update(dt), dispose: (s) => d.dispose(s) }; })],
  ['station', () => itemProxy(() => { const d = new DeployStation(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p) => { d.update(dt, p); }, dispose: (s) => d.dispose(s) }; })],
  ['beacon',  () => itemProxy(() => { const d = new DeployBeacon(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt) => d.update(dt), dispose: (s) => d.dispose(s) }; })],
  ['drone',   () => itemProxy(() => { const d = new DeployDrone(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p) => d.update(dt, p, 0, []), dispose: (s) => d.dispose(s) }; })],
];

// Class lineup — all three armor classes at once (only three exist, a
// picker would be ceremony). REAL PlayerModel instances on the class
// bodies (scifisoldier/cybersoldier/polyart GLBs) so the silhouette,
// fit scale and idle animation are the shipping ones — same trick the
// old classlineup page did by hand, but through the real pipeline.
const CLASS_LINEUP: [cls: ArmorClass, x: number, labelY: number][] = [
  ['light',  -1.9, 2.1],
  ['medium',  0.0, 2.5],
  ['heavy',   2.4, 3.2],
];
function mkTextSprite(text: string, y: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = '600 30px monospace';
  ctx.fillStyle = '#9cf';
  ctx.textAlign = 'center';
  ctx.fillText(text.toUpperCase(), 128, 42);
  const tex = new THREE.CanvasTexture(cv);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = y;
  return s;
}
export const CLASSES: [label: string, build: () => THREE.Group][] = [
  ['classes', () => {
    const proxy = new THREE.Group();
    const models: PlayerModel[] = [];
    for (const [cls, x, ly] of CLASS_LINEUP) {
      const pm = new PlayerModel(LAB_SCENE, CLASS_BODY_VARIANT[cls] as PlayerModelVariant);
      // The gizmo defaults to the generic capsule — without the class
      // sizes the collider wireframe would lie about light/heavy.
      pm.setColliderCapsule(classCapsule(cls));
      void pm.load().then(() => {
        if ((pm as unknown as { _disposed?: boolean })._disposed) {return;}
        pm.setPosition(x, 0, 0);
        pm.setRotation(0, 0); // setRotation adds the rig's authored yaw — 0 is the rig's forward
      });
      models.push(pm);
      const label = mkTextSprite(cls, ly);
      label.position.x = x;
      proxy.add(label);
    }
    proxy.add(creatureLayer); // PlayerModel.scene = LAB_SCENE = creatureLayer
    // Invisible bounds for inspect's Box3 fit — the lineup is wide, not tall.
    const bounds = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.4, 1.4), new THREE.MeshBasicMaterial());
    bounds.visible = false;
    bounds.position.set(0.25, 1.7, 0);
    proxy.add(bounds);
    proxy.userData.liveFocus = () => new THREE.Vector3(0.25, 1.4, 0);
    // Anim rail hook — gunlab's right panel drives all three bodies in
    // lockstep so a state flaw (ski tuck, strafe stride) shows at once.
    proxy.userData.anims = {
      set: (s: AnimationState) => { for (const m of models) {m.forceAnimationState(s);} },
      dir: (f: number, side: number) => { for (const m of models) {m.setLocomotionVector(f, side);} },
      cur: () => models[0]?.animationState,
    };
    // Wire toggle rides along: gunlab calls this on every ▧ wire flip so
    // the class hit capsules show exactly while the tri overlay does.
    proxy.userData.colliderWire = (on: boolean) => {
      for (const m of models) {m.setColliderVisible(on, true);}
    };
    proxy.userData.disposeCreature = () => { for (const m of models) {m.dispose();} previewLive.tick = null; };
    previewLive.tick = (dt) => { for (const m of models) {m.update(dt);} };
    return proxy;
  }],
];
