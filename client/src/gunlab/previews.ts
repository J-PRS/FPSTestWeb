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
import { DeployMortar } from '../entities/DeployMortar.js';
import { DeployCg } from '../entities/DeployCg.js';
import { DeployShield } from '../entities/DeployShield.js';
import { DeployStation } from '../entities/DeployStation.js';
import { DeployBeacon } from '../entities/DeployBeacon.js';
import { DeployDrone } from '../entities/DeployDrone.js';
import { SWARM_SPECS } from '../game/species/registry.js';
import type { Terrain } from '../world/terrain.js';
import { PICKUP_ACCENT, pickupParts } from '../entities/PickupModel.js';
import { metalMat } from '../entities/procMetal.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { bakeWearOnly } from '../effects/vertexAO.js';
import { EMIT_GAIN } from '../core/config.js';
import type { PickupKind } from '../../../shared/pickups.js';
import { mkFlagPlate } from '../game/flagRun.js';
import { mkFlagMesh } from '../game/ctfFlags.js';
import { TEAM_COLORS } from '../../../shared/teams.js';
import { PlayerModel, type PlayerModelVariant } from '../entities/PlayerModel.js';
import { CLASS_BODY_MAT_REV, CLASS_BODY_VARIANT, type AnimationState } from '../entities/playerClips.js';
import { CLASS_MODEL_SCALE, classCapsule, type ArmorClass } from '../../../shared/botClasses.js';

// The one live-body tick — whichever preview proxy is parked owns it.
// gunlab's render loop reads it through this holder so proxy builders
// can install/clear it without reaching into the main module.
import { mkBastion, mkBaseTower, mkWallRun, mkWallGate, mkGenDome, mkLandingPad, mkCommsMast, mkKataStand, mkBunker, mkFlagTower, mkPillar, mkObelisk, mkArch, mkShard } from '../structures/structures.js';
import { ramp } from '../structures/structKit.js';
import { KIT_BUILDERS } from '../world/mapStructures.js';
import { resolveMapSpec, parseMapSpecJson } from '../../../shared/mapSpec.js';
import bastionJson from '../../../maps/bastion.json';
export const previewLive: { tick: ((dt: number) => void) | null } = { tick: null };

// Camera world position is what creature AI and deployable tracking
// aim at — installed once by initPreviews since the tables below are
// built lazily, possibly before a camera exists.
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let cam!: THREE.Camera;
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
  getHeight: (): number => 0,
  getHeightVisual: (): number => 0,
  getNormal: (): THREE.Vector3 => new THREE.Vector3(0, 1, 0),
  // Swarm blob shadows + terrainBlend read the SAME uniform objects a
  // real Terrain exposes — a flat 1×1 zero field keeps the stub honest.
  heightU: (() => {
    const hmap = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    hmap.needsUpdate = true;
    return {
      heightMap: { value: hmap as THREE.DataTexture | null },
      hmWorldScale: { value: 1000 },
      hScale: { value: 60 },
    };
  })(),
  // Decal APIs the deployables call when seating — a real handle object
  // so intensity tweens still land somewhere; there's just no clipmap
  // shader on the other end.
  addFieldRing: (x: number, z: number, r: number, tint: readonly number[]): { x: number; z: number; r: number; intensity: number; tint: readonly number[]; } => ({ x, z, r, intensity: 0.5, tint }),
  removeFieldRing: (): undefined => undefined,
  addScorch: (): null => null,
  addSplat: (): null => null,
} as unknown as Terrain;

function ensureSwarms(): void {
  if (swarmsReady) {return;}
  // The full live registry, shrunk to single-specimen buffers — a new
  // species shows up in the lab the moment it's registered, no lab edit.
  const labSpecs = Object.fromEntries(
    Object.entries(SWARM_SPECS).map(([k, s]) => [k, Object.assign({}, s, {capacity: 8})]),
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
  proxy.userData.liveFocus = (): THREE.Vector3 => c.pos;
  // Explicit dispose, NOT a 'removed' listener — inspect re-parents this
  // proxy (vm.group → scene) and 'removed' fires on every reparent,
  // which would slaughter the creature on each mode toggle.
  proxy.userData.disposeCreature = (): void => { c.dispose(); previewLive.tick = null; };
  // Feed playerPos in PROXY space, not world space: inspect mode
  // recentres/rotates the proxy, so a world-space camera pos would leave
  // the AI aiming at a phantom — the barrel misses you by exactly the
  // recentre offset. Local space keeps aim honest under any placement.
  previewLive.tick = (dt): void => {
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
    .filter(([, s]): ((scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) => LabEntity) | undefined => s.spawn)
    .map(([name, s]): [string, () => THREE.Group] =>
      [name, (): THREE.Group<THREE.Object3DEventMap> => creatureProxy((): LabEntity => s.spawn!(LAB_SCENE, LAB_TERRAIN, new THREE.Vector3()))]),
  ['buzzard', (): THREE.Group<THREE.Object3DEventMap> => creatureProxy(() => {
    const kettle = new AmbientBirds(LAB_SCENE, 0.08);
    return {
      pos: kettle.birds[0]!.group.position, radius: 2.5,
      update: (dt, _t, p): void => kettle.update(dt, p, LAB_TERRAIN),
      dispose: (): void => kettle.dispose(),
    };
  })],
];

// Pickup previews — every kind is the same tumbling gem body (mesh +
// additive halo sprite) sold by its PICKUP_ACCENT tint, so the table
// builds straight off that map: new kinds appear here automatically.
const NUGGET_R = 0.3; // Nugget.ts NUGGET_RADIUS — keep in step
function buildNugget(kind: PickupKind): () => THREE.Group {
  return (): THREE.Group<THREE.Object3DEventMap> => {
    const g = new THREE.Group();
    const base = new THREE.Color(PICKUP_ACCENT[kind]);
    const emit = base.clone().lerp(new THREE.Color(0xFF_FF_FF), 0.33).multiplyScalar(EMIT_GAIN);
    // Diegetic kinds get the real pickupParts body+accent — the same
    // shapes/materials Nugget builds in-game. Null parts keep the plain
    // gem (gem kind itself).
    const parts = pickupParts(kind);
    // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
    let gem!: THREE.Mesh;
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
    previewLive.tick = (): void => {
      g.updateMatrixWorld();
      const local = g.worldToLocal(cam.getWorldPosition(_camW));
      halo.position.copy(local.normalize().multiplyScalar(-0.25));
    };
    g.userData.disposeCreature = (): void => { previewLive.tick = null; };
    return g;
  };
}
export const PICKUPS: [label: string, build: () => THREE.Group][] =
  (Object.keys(PICKUP_ACCENT) as PickupKind[]).map((k): [PickupKind, () => THREE.Group] => [k, buildNugget(k)]);

// Base structures — the structKit compositions, real builders straight
// out of structures.ts. Big pieces: liveFocus parks the camera framing
// on the compound center rather than the group origin.
export const STRUCTURES: [label: string, build: () => THREE.Group][] = [
  // The deployed map verbatim — same bastion.json + resolveMapSpec +
  // KIT_BUILDERS path the game renders, so the lab can never show a
  // stale layout. Flat terrain here (no seatKits): authored y stands.
  ['[MAP] bastion', (): THREE.Group<THREE.Object3DEventMap> => {
    const spec = resolveMapSpec(parseMapSpecJson(JSON.stringify(bastionJson)));
    const g = new THREE.Group();
    for (const s of spec.structures ?? []) {
      if (s.kind === 'kit') {
        const mk = KIT_BUILDERS[s.piece ?? ''];
        if (!mk) {continue;}
        const piece = mk(s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF);
        piece.position.set(s.pos.x, s.pos.y, s.pos.z);
        piece.rotation.y = s.rotY ?? 0;
        if (s.scale && s.scale !== 1) {piece.scale.setScalar(s.scale);}
        g.add(piece);
      } else if (s.kind === 'shield' && s.size.y > 0) {
        const color = s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF;
        const pane = new THREE.Mesh(
          new THREE.BoxGeometry(s.size.x, s.size.y, Math.max(0.25, s.size.z)),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
        pane.position.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
        pane.rotation.y = s.rotY ?? 0;
        g.add(pane);
      }
    }
    // Frame alpha's compound — the authored cluster center.
    g.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(-500, 40, 60);
    return g;
  }],
  ['bastion', (): THREE.Group<THREE.Object3DEventMap> => {
    const g = mkBastion();
    g.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(0, 4, -4);
    return g;
  }],
  ['katastand', (): THREE.Group<THREE.Object3DEventMap> => mkKataStand()],
  ['bunker',   (): THREE.Group<THREE.Object3DEventMap> => mkBunker(12, 10, 4.2)],
  ['flagtower', (): THREE.Group<THREE.Object3DEventMap> => mkFlagTower()],
  ['tower',    (): THREE.Group<THREE.Object3DEventMap> => mkBaseTower(9, 12)],
  ['wallrun',  (): THREE.Group<THREE.Object3DEventMap> => mkWallRun(18, 4.2)],
  ['wallgate', (): THREE.Group<THREE.Object3DEventMap> => mkWallGate(18, 4.2, 6)],
  ['ramp',     (): THREE.Group<THREE.Object3DEventMap> => ramp(5, 12, 2.5)],
  ['gendome',  (): THREE.Group<THREE.Object3DEventMap> => mkGenDome(5)],
  ['landpad',  (): THREE.Group<THREE.Object3DEventMap> => mkLandingPad(4.5)],
  ['commast',  (): THREE.Group<THREE.Object3DEventMap> => mkCommsMast(10)],
  ['pillar',   (): THREE.Group<THREE.Object3DEventMap> => mkPillar()],
  ['obelisk',  (): THREE.Group<THREE.Object3DEventMap> => mkObelisk()],
  ['arch',     (): THREE.Group<THREE.Object3DEventMap> => mkArch()],
  ['shard',    (): THREE.Group<THREE.Object3DEventMap> => mkShard()],
];

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
  bakeWearOnly(proxy, { grime: true });
  proxy.userData.liveFocus = (): THREE.Vector3 => it.group.getWorldPosition(new THREE.Vector3());
  proxy.userData.disposeCreature = (): void => { it.dispose(LAB_SCENE); previewLive.tick = null; };
  if (it.update) {
    previewLive.tick = (dt): void => {
      proxy.updateMatrixWorld();
      it.update!(dt, proxy.worldToLocal(cam.getWorldPosition(_camW)));
    };
  }
  return proxy;
}
export const ITEMS: [label: string, build: () => THREE.Group][] = [
  // Flag on its floor plate — the flagrun pad + the shared flag mesh,
  // the in-game pair previewed as one piece — plus each half alone.
  ['flag', (): THREE.Group<THREE.Object3DEventMap> => {
    const g = new THREE.Group();
    g.add(mkFlagPlate(TEAM_COLORS.alpha));
    const flag = mkFlagMesh('alpha');
    flag.position.y = 0.46; // pole inserts into the socket mouth
    g.add(flag);
    return g;
  }],
  ['flag alone', (): THREE.Group<THREE.Object3DEventMap> => mkFlagMesh('alpha')],
  ['stand',     (): THREE.Group<THREE.Object3DEventMap> => mkFlagPlate(TEAM_COLORS.alpha)],
  ['sentry',  (): THREE.Group<THREE.Object3DEventMap> => { ensureSwarms(); const d = new DeployTurret(LAB_SCENE, LAB_TERRAIN, _zero); const proxy = new THREE.Group(); proxy.add(d.group, creatureLayer); proxy.userData.liveFocus = (): THREE.Vector3 => d.group.getWorldPosition(new THREE.Vector3()); proxy.userData.disposeCreature = (): void => { d.dispose(LAB_SCENE); previewLive.tick = null; }; previewLive.tick = (dt): void => { proxy.updateMatrixWorld(); d.update(dt, []); }; bakeWearOnly(proxy, { grime: true }); return proxy; }],
  ['mortar',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployMortar(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt) => { d.update(dt, []); }, dispose: (s): void => d.dispose(s) }; })],
  ['minigun', (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployCg(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt) => { d.update(dt, []); }, dispose: (s): void => d.dispose(s) }; })],
  ['shield',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployShield(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
  ['station', (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployStation(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p): void => { d.update(dt, p); }, dispose: (s): void => d.dispose(s) }; })],
  ['beacon',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployBeacon(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
  ['drone',   (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployDrone(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p) => d.update(dt, p, 0, []), dispose: (s): void => d.dispose(s) }; })],
];

// Class lineup — all three armor classes at once (only three exist, a
// picker would be ceremony). REAL PlayerModel instances on the class
// bodies (scifisoldier/cybersoldier/polyart GLBs) so the silhouette,
// fit scale and idle animation are the shipping ones — same trick the
// old classlineup page did by hand, but through the real pipeline.
const CLASS_LINEUP: [cls: ArmorClass, x: number, labelY: number][] = [
  ['light',  -1.9, 2.1],
  ['medium',  0, 2.5],
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
  ['classes', (): THREE.Group<THREE.Object3DEventMap> => {
    const proxy = new THREE.Group();
    const models: PlayerModel[] = [];
    for (const [cls, x, ly] of CLASS_LINEUP) {
      const pm = new PlayerModel(LAB_SCENE, CLASS_BODY_VARIANT[cls] as PlayerModelVariant, CLASS_BODY_MAT_REV.has(cls));
      // The gizmo defaults to the generic capsule — without the class
      // sizes the collider wireframe would lie about light/heavy.
      pm.setColliderCapsule(classCapsule(cls));
      pm.load().then((): void => {
        if ((pm as unknown as { _disposed?: boolean })._disposed) {return;}
        pm.setScale(CLASS_MODEL_SCALE[cls]); // real tier silhouette, not raw rig height
        pm.setPosition(x, 0, 0);
        pm.setRotation(0, 0); // setRotation adds the rig's authored yaw — 0 is the rig's forward
      return; }).catch((): void => undefined);
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
    proxy.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(0.25, 1.4, 0);
    // Anim rail hook — gunlab's right panel drives all three bodies in
    // lockstep so a state flaw (ski tuck, strafe stride) shows at once.
    proxy.userData.anims = {
      set: (s: AnimationState): void => { for (const m of models) {m.forceAnimationState(s);} },
      dir: (f: number, side: number): void => { for (const m of models) {m.setLocomotionVector(f, side);} },
      cur: (): "jump" | "ski" | "idle" | "walk" | "run" | "death" | "hit" | "shoot" | "jet" | "throw" => models[0]?.animationState,
    };
    // Wire toggle rides along: gunlab calls this on every ▧ wire flip so
    // the class hit capsules show exactly while the tri overlay does.
    proxy.userData.colliderWire = (on: boolean): void => {
      for (const m of models) {m.setColliderVisible(on, true);}
    };
    proxy.userData.disposeCreature = (): void => { for (const m of models) {m.dispose();} previewLive.tick = null; };
    previewLive.tick = (dt): void => { for (const m of models) {m.update(dt);} };
    return proxy;
  }],
];
