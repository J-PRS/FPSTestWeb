// procMetal — the "procedural gunmetal" recipe, shared so anything that
// should read as worn machined metal picks it up in one call. The look
// is two cooperating halves:
//   1. MeshStandardMaterial at moderate metalness — real specular
//      response, which Lambert bodies can't show (weaponKit mats are
//      Lambert; that's why they read matte).
//   2. bakeVertexAO's wear/grime vertex data — on a Lambert it just
//      darkens; on metalness it modulates the specular and the grunge
//      reads as actual brushed/worn metal instead of a smudge.
// So: use metalMat() for a body, let bakeVertexAO/attachEdgeWear do the
// rest, don't set maps — the vertex data IS the texture.

import * as THREE from 'three';

/** Standard gunmetal — the pickup-body defaults (Nugget.ts diegetic
 *  bodies, dd cage, armor laminate). */
export function metalMat(color = 0x3A4048, opts: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.75,
  });
}

/** Tumbled/worn variant — rougher + less metal, for parts that should
 *  read used rather than machined (struts, housings, cage rods). */
export function wornMetalMat(color = 0x3A4048): THREE.MeshStandardMaterial {
  return metalMat(color, { roughness: 0.6, metalness: 0.55 });
}
