// Parsed-GLTF scene serializer — a GLTFLoader result crossing a Worker
// boundary can't postMessage as Object3D; walk it into transferable
// typed arrays here and rebuild real THREE objects on the far side.
// The worker pays the meshopt decode; main pays only BufferGeometry
// construction (array wraps — no decode).
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

type Buf = { b: number; off: number; len: number; ctor: string };
type Attr = { name: string; buf: Buf; itemSize: number; norm: boolean; stride?: number; off?: number };
type Tex = { bmp: ImageBitmap; flipY: boolean; ch: number; rep: [number, number]; off: [number, number]; rot: number };
type Mat = {
  name: string; color: [number, number, number]; metal: number; rough: number;
  emis: [number, number, number]; emisInt: number; opac: number; transp: boolean;
  side: number; alphaTest: number;
  map?: Tex; nrm?: Tex; rgh?: Tex; mtl?: Tex; ao?: Tex; emi?: Tex;
};
type Skin = { joints: number[]; inverses: ArrayBuffer; bind: ArrayBuffer };
type Mesh = { attrs: Attr[]; index?: Buf; groups?: { start: number; count: number; materialIndex: number }[]; mats: number[]; skin?: Skin };
type Node = { name: string; pos: number[]; quat: number[]; scl: number[]; bone: boolean; vis: boolean; kids: number[]; ud?: Record<string, unknown>; mesh?: Mesh };
type Track = { name: string; kind: string; times: Buf; values: Buf };
type Clip = { name: string; duration: number; tracks: Track[] };
type Ser = { nodes: Node[]; mats: Mat[]; clips: Clip[]; bufs: ArrayBuffer[] };

type TypedArr = Float32Array | Float64Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
const CTOR: Record<string, new (b: ArrayBuffer, o: number, n: number) => TypedArr> = {
  Float32Array, Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float64Array,
};

/** Typed-array → transferable slot. Buffers are deduped (two attributes can
 *  share one buffer; transferring it twice detaches on the first). */
function serArr(ser: Ser, a: THREE.TypedArray): Buf {
  let b = ser.bufs.indexOf(a.buffer as ArrayBuffer);
  if (b < 0) {b = ser.bufs.length; ser.bufs.push(a.buffer as ArrayBuffer);}
  return { b, off: a.byteOffset, len: a.byteLength, ctor: a.constructor.name };
}

function serTex(t: THREE.Texture | null): Tex | undefined {
  if (!t || !(t.image instanceof ImageBitmap)) {return undefined;}
  return { bmp: t.image, flipY: t.flipY, ch: t.channel, rep: [t.repeat.x, t.repeat.y], off: [t.offset.x, t.offset.y], rot: t.rotation };
}

function serMat(m: THREE.Material, ser: Ser): number {
  const s = m as THREE.MeshStandardMaterial;
  const cur = ser.mats.length;
  ser.mats.push({
    name: m.name, color: s.color ? [s.color.r, s.color.g, s.color.b] : [1, 1, 1],
    metal: s.metalness ?? 1, rough: s.roughness ?? 1,
    emis: s.emissive ? [s.emissive.r, s.emissive.g, s.emissive.b] : [0, 0, 0],
    emisInt: s.emissiveIntensity ?? 1,
    opac: s.opacity ?? 1, transp: s.transparent === true,
    side: s.side ?? 0, alphaTest: s.alphaTest ?? 0,
    map: serTex(s.map), nrm: serTex(s.normalMap), rgh: serTex(s.roughnessMap),
    mtl: serTex(s.metalnessMap), ao: serTex(s.aoMap), emi: serTex(s.emissiveMap),
  });
  return cur;
}

function serMesh(ser: Ser, mesh: THREE.Mesh | THREE.SkinnedMesh, matIdx: Map<THREE.Material, number>, nodeIdx: Map<THREE.Object3D, number>): Mesh {
  const g = mesh.geometry;
  const out: Attr[] = [];
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name);
    if (a && (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
      const il = a as THREE.InterleavedBufferAttribute;
      out.push({
        name,
        buf: serArr(ser, il.data.array as TypedArr),
        itemSize: il.itemSize, norm: il.normalized,
        stride: il.data.stride, off: il.offset,
      });
      continue;
    }
    if (!a?.isBufferAttribute) {
      const e = new Error(`glbSer: unserializable attribute ${name}`);
      (e as { __ser?: boolean }).__ser = true;
      throw e;
    }
    out.push({ name, buf: serArr(ser, a.array as TypedArr), itemSize: a.itemSize, norm: a.normalized });
  }
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .map((m): number => matIdx.get(m) ?? ((): number => { const i = serMat(m, ser); matIdx.set(m, i); return i; })());
  const sm = mesh as THREE.SkinnedMesh;
  const skin: Skin | undefined = sm.isSkinnedMesh && sm.skeleton ? {
    joints: sm.skeleton.bones.map((b): number => nodeIdx.get(b) ?? -1),
    inverses: new Float32Array(sm.skeleton.boneInverses.flatMap((x): number[] => x.elements)).buffer as ArrayBuffer,
    bind: new Float32Array(sm.bindMatrix.elements).buffer as ArrayBuffer,
  } : undefined;
  return {
    attrs: out,
    index: g.index ? serArr(ser, g.index.array as THREE.TypedArray) : undefined,
    groups: g.groups.length > 0 ? g.groups.map((x): { start: number; count: number; materialIndex: number } => ({ start: x.start, count: x.count, materialIndex: x.materialIndex })) : undefined,
    mats,
    skin,
  };
}

/** scene + animations → flat transferable. Throws on shapes we don't
 *  carry (morphs, interleaved attrs, non-bitmap textures) — callers fall
 *  back to a main-thread parse for those files. */
export function serializeGltf(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): { data: Ser; transfers: Transferable[] } {
  const ser: Ser = { nodes: [], mats: [], clips: [], bufs: [] };
  const nodeIdx = new Map<THREE.Object3D, number>();
  // Index pass first — skin joint refs need every node's slot before
  // meshes serialize (a joint can sit below its SkinnedMesh sibling).
  gltf.scene.traverse((o): void => { nodeIdx.set(o, nodeIdx.size); });
  const matIdx = new Map<THREE.Material, number>();
  gltf.scene.traverse((o): void => {
    const n: Node = {
      name: o.name, pos: [o.position.x, o.position.y, o.position.z],
      quat: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
      scl: [o.scale.x, o.scale.y, o.scale.z],
      bone: (o as THREE.Bone).isBone === true, vis: o.visible,
      kids: o.children.map((c): number => nodeIdx.get(c) ?? -1).filter((i): boolean => i >= 0),
      ud: Object.keys(o.userData).length > 0 ? Object.assign({}, o.userData) : undefined,
    };
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (Object.keys(m.geometry.morphAttributes).length > 0) {
        const e = new Error('glbSer: morph attributes unsupported');
        (e as { __ser?: boolean }).__ser = true;
        throw e;
      }
      n.mesh = serMesh(ser, m, matIdx, nodeIdx);
    }
    ser.nodes[nodeIdx.get(o)!] = n;
  });
  ser.nodes.length = nodeIdx.size;
  for (const c of gltf.animations) {
    ser.clips.push({
      name: c.name, duration: c.duration,
      tracks: c.tracks.map((t): Track => ({
        name: t.name, kind: t.ValueTypeName,
        times: serArr(ser, t.times), values: serArr(ser, t.values),
      })),
    });
  }
  const transfers = [...ser.bufs];
  for (const m of ser.mats) {
    for (const t of [m.map, m.nrm, m.rgh, m.mtl, m.ao, m.emi]) {if (t) {transfers.push(t.bmp);}}
  }
  return { data: ser, transfers };
}

function arr(ser: Ser, b: Buf): THREE.TypedArray {
  const buf = ser.bufs[b.b];
  const Ctor = CTOR[b.ctor];
  if (!buf || !Ctor) {throw new Error(`glbSer: bad buffer ${b.b}/${b.ctor}`);}
  return new Ctor(buf, b.off, Math.floor(b.len / Ctor.BYTES_PER_ELEMENT));
}

function tex(t: Tex | undefined): THREE.Texture | null {
  if (!t) {return null;}
  const x = new THREE.Texture(t.bmp);
  x.flipY = t.flipY; x.channel = t.ch;
  x.repeat.set(t.rep[0], t.rep[1]); x.offset.set(t.off[0], t.off[1]); x.rotation = t.rot;
  x.needsUpdate = true;
  return x;
}

/** serialized payload → real THREE objects. Rebuild is the main-thread
 *  half — BufferGeometry wraps the transferred arrays (no decode), the
 *  material construction is the same work any loader would pay. */
export function rebuildGltf(ser: Ser): GLTF {
  const mats = ser.mats.map((m): THREE.MeshStandardMaterial => {
    const s = new THREE.MeshStandardMaterial();
    s.name = m.name; s.color.setRGB(m.color[0], m.color[1], m.color[2]);
    s.metalness = m.metal; s.roughness = m.rough;
    s.emissive.setRGB(m.emis[0], m.emis[1], m.emis[2]); s.emissiveIntensity = m.emisInt;
    s.opacity = m.opac; s.transparent = m.transp; s.side = m.side; s.alphaTest = m.alphaTest;
    s.map = tex(m.map); s.normalMap = tex(m.nrm); s.roughnessMap = tex(m.rgh);
    s.metalnessMap = tex(m.mtl); s.aoMap = tex(m.ao); s.emissiveMap = tex(m.emi);
    return s;
  });
  const objs: THREE.Object3D[] = ser.nodes.map((n): THREE.Object3D => {
    if (n.mesh) {
      const g = new THREE.BufferGeometry();
      for (const a of n.mesh.attrs) {
        const raw = arr(ser, a.buf);
        if (a.stride !== undefined) {
          const il = new THREE.InterleavedBuffer(raw, a.stride);
          g.setAttribute(a.name, new THREE.InterleavedBufferAttribute(il, a.itemSize, a.off ?? 0, a.norm));
        } else {
          g.setAttribute(a.name, new THREE.BufferAttribute(raw, a.itemSize, a.norm));
        }
      }
      if (n.mesh.index) {g.setIndex(new THREE.BufferAttribute(arr(ser, n.mesh.index), 1));}
      if (n.mesh.groups) {for (const x of n.mesh.groups) {g.addGroup(x.start, x.count, x.materialIndex);}}
      const mm = n.mesh.mats.map((i): THREE.Material => mats[i]!);
      // A single group → single material (GLTFLoader's own shape — an
      // array-of-one reads as undefined to `mesh.material as Material`).
      const mmOrOne = mm.length === 1 ? mm[0]! : mm;
      const m = n.mesh.skin ? new THREE.SkinnedMesh(g, mmOrOne) : new THREE.Mesh(g, mmOrOne);
      m.castShadow = true;
      return m;
    }
    return n.bone ? new THREE.Bone() : new THREE.Object3D();
  });
  ser.nodes.forEach((n, i): void => {
    const o = objs[i]!;
    o.name = n.name; o.position.set(n.pos[0], n.pos[1], n.pos[2]);
    o.quaternion.set(n.quat[0], n.quat[1], n.quat[2], n.quat[3]);
    o.scale.set(n.scl[0], n.scl[1], n.scl[2]);
    o.visible = n.vis;
    if (n.ud) {o.userData = n.ud;}
    for (const k of n.kids) {o.add(objs[k]!);}
  });
  // Skeletons bind after the tree — joints can be anywhere in it.
  ser.nodes.forEach((n, i): void => {
    if (!n.mesh?.skin) {return;}
    const sm = objs[i] as THREE.SkinnedMesh;
    const bones = n.mesh.skin.joints.map((j): THREE.Bone => objs[j] as THREE.Bone);
    const boneInverses: THREE.Matrix4[] = [];
    const inv = new Float32Array(n.mesh.skin.inverses);
    for (let j = 0; j < bones.length; j += 1) {boneInverses.push(new THREE.Matrix4().fromArray(inv, j * 16));}
    sm.bind(new THREE.Skeleton(bones, boneInverses), new THREE.Matrix4().fromArray(new Float32Array(n.mesh.skin)));
  });
  const clips = ser.clips.map((c): THREE.AnimationClip => new THREE.AnimationClip(c.name, c.duration, c.tracks.map((t): THREE.KeyframeTrack => {
    const times = arr(ser, t.times), values = arr(ser, t.values);
    if (t.kind === 'quaternion') {return new THREE.QuaternionKeyframeTrack(t.name, times as Float32Array, values as Float32Array);}
    if (t.kind === 'vector' || t.kind === 'bool') {return new THREE.VectorKeyframeTrack(t.name, times as Float32Array, values as Float32Array);}
    return new THREE.NumberKeyframeTrack(t.name, times as Float32Array, values as Float32Array);
  })));
  const scene = objs[0] as THREE.Group;
  return { scene, scenes: [scene], animations: clips, cameras: [], asset: {}, parser: {} as GLTF['parser'], userData: {} };
}
