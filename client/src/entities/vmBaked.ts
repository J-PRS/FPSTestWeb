import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WeaponType } from '../../../shared/weapons.js';
import { urlParams } from '../core/params.js';
import { bakeVertexAO } from '../effects/vertexAO.js';

// Baked-weapon swap — the GLB+AO adoption pipeline for the viewmodel.
// When tools/vmdump has shipped w{id}_baked.glb/w{id}_ao.png, the baked
// mesh replaces the procedural one part-by-part (glow parts stay
// procedural). Kept off ViewModel so the load path isn't tangled with
// the per-frame envelope/kick code.

/** Flat host surface — everything the swap reads or writes. */
export interface BakedHost {
  readonly weapons: Map<number, THREE.Group>;
  /** The chaingun spin group — re-pointed when the bake's barrels node
   *  gets reseated under a bore-centered pivot. */
  chainBarrels: THREE.Group | null;
  /** Bore axis in the spin node's local space — recomputed on adoption
   *  (a Blender export node carries foreign axes; rotating .z cartwheels). */
  spinAxis: THREE.Vector3;
  /** Live ghost materials — a bake landing mid-cloak must join the set. */
  readonly ghostMats: readonly unknown[];
  ghostify(m: THREE.Material): void;
  ghostifyMesh(mesh: THREE.Mesh): void;
}

export class VmBaked {
  constructor(private h: BakedHost) {}

  /** Probes every weapon for a bake and swaps what lands. Missing bakes
   *  are the normal case — those weapons bake their vertex AO now
   *  (deferred from the ctor: swapped weapons would discard it). */
  async load(): Promise<void> {
    // Export mode must serialize the PROCEDURAL meshes — if the baked swap
    // lands mid-export the GLB round-trips the stale bake and the pipeline
    // can never pick up new geometry. Still bake AO: the dump pipeline
    // round-trips the procedural vertex colors into the GLB.
    if (urlParams.has('export')) {
      for (const g of this.h.weapons.values()) bakeVertexAO(g);
      return;
    }
    const loader = new GLTFLoader();
    const texLoader = new THREE.TextureLoader();
    const done = new Set<THREE.Group>();
    for (const [wt, g] of this.h.weapons) {
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
        bakeVertexAO(g);
        // A missing bake is the normal case — 404s surface as
        // Event/ProgressEvent (ImageLoader) or "Not Found"/404 Errors —
        // neither is worth a log line. Only a real parse/decode failure is.
        const is404 = !(e instanceof Error) ||
          /404|not found|fetch/i.test(e.message);
        if (!is404) console.log(`[vm] w${wt} bake load failed:`, e);
      }
    }
  }

  /** One weapon's bake swap: fetch glb+AO, replace non-glow procedural
   *  meshes with the bake, seat the chaingun spin pivot, ghost it if a
   *  cloak is active. Throws on missing bakes — the caller treats 404 as
   *  "procedural stays", silently. */
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
    if (this.h.ghostMats.length) {
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
          this.h.ghostify(m);
        }
      });
      for (const mesh of toShell) this.h.ghostifyMesh(mesh);
    }
    console.log(`[vm] w${wt} baked swap: removed ${swap.size} procedural meshes`);
  }

  /** Finds the bake's "barrels" node (Blender dedups to 'barrels.001'
   *  when the group empty lingers) and fetches its own small
   *  w{id}b_ao.png bake. Returns null on a merged bake — the swap is
   *  then skipped entirely. */
  private async adoptChainSpin(scene: THREE.Object3D, wt: number, texLoader: THREE.TextureLoader):
    Promise<{ node: THREE.Object3D; barrelMat: THREE.MeshLambertMaterial | null } | null> {
    let node: THREE.Object3D | undefined;
    scene.traverse((o) => { if (!node && o.name.startsWith('barrels')) node = o; });
    if (!node) return null;
    this.h.chainBarrels = node as THREE.Group;
    let barrelMat: THREE.MeshLambertMaterial | null = null;
    try {
      const btex = await texLoader.loadAsync(`/weapons/w${wt}b_ao.png?v=${Date.now()}`);
      btex.flipY = false;
      btex.colorSpace = THREE.LinearSRGBColorSpace;
      barrelMat = new THREE.MeshLambertMaterial({ map: btex });
    } catch { barrelMat = null; }
    return { node, barrelMat };
  }

  /** The bake node's origin isn't the cluster center — spinning it
   *  directly orbits the triad around one barrel. Wraps it in a pivot
   *  seated on the bore line (weapon-space x=0,y=0 at barrel z) and spins
   *  THAT. Matrix math runs after the reparent so matrixWorld already
   *  includes g's transform. */
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
    this.h.spinAxis.set(0, 0, -1)
      .transformDirection(new THREE.Matrix4().copy(parentInv).multiply(g.matrixWorld));
    this.h.chainBarrels = pivot;
  }
}
