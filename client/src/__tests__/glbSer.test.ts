import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { serializeGltf, rebuildGltf } from '../glbSer';

/** Worker boundary round-trip: a skinned rig scene must survive
 *  serialize → transfer → rebuild with real skeleton, attrs and clips. */
const mkScene = (): { scene: THREE.Group; animations: THREE.AnimationClip[] } => {
    const root = new THREE.Group();
    root.name = 'root';
    const bone = new THREE.Bone();
    bone.name = 'hip';
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int16Array([0, 0, 32_767, 0, 0, 32_767, 0, 0, 32_767]), 3, true));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const mat = new THREE.MeshStandardMaterial();
    mat.name = 'body'; mat.color.setRGB(0.5, 0.6, 0.7); mat.metalness = 0.2; mat.roughness = 0.8;
    const sm = new THREE.SkinnedMesh(geo, mat);
    sm.name = 'body';
    const skel = new THREE.Skeleton([bone], [new THREE.Matrix4().makeTranslation(0, -1, 0)]);
    sm.bind(skel, new THREE.Matrix4());
    root.add(bone); root.add(sm);
    const clip = new THREE.AnimationClip('walk', 1, [
      new THREE.QuaternionKeyframeTrack('hip.quaternion', new Float32Array([0, 1]), new Float32Array([0, 0, 0, 1, 0, 0, 0, 1])),
      new THREE.VectorKeyframeTrack('hip.position', new Float32Array([0, 1]), new Float32Array([0, 0, 0, 0, 1, 0])),
    ]);
    return { scene: root, animations: [clip] };
  };

describe('glbSer round trip', () => {
  test('skin, attrs, materials and clips survive the hop', () => {
    const { data } = serializeGltf(mkScene());
    const g = rebuildGltf(data);
    const sm = g.scene.getObjectByName('body') as THREE.SkinnedMesh;
    expect(sm.isSkinnedMesh).toBe(true);
    expect((g.scene.getObjectByName('hip') as THREE.Bone).isBone).toBe(true);
    expect(sm.skeleton.bones).toHaveLength(1);
    expect(sm.skeleton.boneInverses[0]!.elements[13]).toBeCloseTo(-1);
    expect(sm.geometry.getAttribute('position').itemSize).toBe(3);
    expect(sm.geometry.getAttribute('normal').array).toBeInstanceOf(Int16Array);
    expect(sm.geometry.getAttribute('normal').normalized).toBe(true);
    expect(sm.geometry.getAttribute('skinIndex').array).toBeInstanceOf(Uint16Array);
    expect(sm.geometry.index!.count).toBe(3);
    const mat = sm.material as THREE.MeshStandardMaterial;
    expect(mat.name).toBe('body');
    expect(mat.metalness).toBeCloseTo(0.2);
    expect(mat.color.g).toBeCloseTo(0.6);
    expect(g.animations).toHaveLength(1);
    expect(g.animations[0]!.name).toBe('walk');
    expect(g.animations[0]!.tracks[0]).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
    expect(g.animations[0]!.tracks[1]).toBeInstanceOf(THREE.VectorKeyframeTrack);
  });

  test('morph attributes refuse the hop (caller falls back)', () => {
    const { scene, animations } = mkScene();
    const sm = scene.getObjectByName('body') as THREE.SkinnedMesh;
    sm.geometry.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(9), 3)];
    expect(() => serializeGltf({ scene, animations })).toThrow('glbSer');
  });

  test('shared buffer dedupes (two attrs, one backing buffer)', () => {
    const { scene, animations } = mkScene();
    const sm = scene.getObjectByName('body') as THREE.SkinnedMesh;
    const shared = new Float32Array([9, 9, 9, 8, 8, 8]);
    sm.geometry.setAttribute('a2a', new THREE.BufferAttribute(new Float32Array(shared.buffer, 0, 3), 3));
    sm.geometry.setAttribute('a2b', new THREE.BufferAttribute(new Float32Array(shared.buffer, 12, 3), 3));
    const { data } = serializeGltf({ scene, animations });
    const g = rebuildGltf(data);
    const sm2 = g.scene.getObjectByName('body') as THREE.SkinnedMesh;
    expect(sm2.geometry.getAttribute('a2a').array[0]).toBe(9);
    expect(sm2.geometry.getAttribute('a2b').array[0]).toBe(8);
    expect(sm2.geometry.getAttribute('a2a').array.buffer).toBe(sm2.geometry.getAttribute('a2b').array.buffer);
  });
});
