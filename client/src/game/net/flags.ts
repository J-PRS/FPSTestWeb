// Server-owned CTF flags — dumb renderers: pole+banner meshes that just
// follow flagUpdate positions. All rules live in RoomFlags server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';

export function wireFlags(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;

  // Carried flags get no position stream (server stopped broadcasting it) —
  // the mesh pins to the carrier's rendered position at draw time instead,
  // which is smoother than any wire rate anyway.
  const flagMeshes = new Map<string, THREE.Group>();
  const flagCarriers = new Map<string, string>();
  const ensureFlagMesh = (team: 'alpha' | 'bravo'): THREE.Group => {
    let g = flagMeshes.get(team);
    if (g) return g;
    g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 4, 6),
      new THREE.MeshBasicMaterial({ color: 0x888888 }));
    pole.position.y = 2;
    const banner = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.2, 4),
      new THREE.MeshBasicMaterial({ color: team === 'alpha' ? 0x55aaff : 0xff8855 }));
    banner.position.set(0.55, 3.4, 0);
    g.add(pole, banner);
    g.onBeforeRender = () => {
      const carrier = flagCarriers.get(team);
      if (!carrier) return;
      if (carrier === networkManager.getLocalPlayerId()) {
        g.position.copy(deps.lazyPlayer().pos);
      } else {
        const rp = deps.world.remotePlayers.get(carrier);
        if (rp) g.position.copy(rp.pos);
      }
      g.position.y += 0.4; // ride the shoulders, not the boots
    };
    deps.lazyScene().add(g);
    flagMeshes.set(team, g);
    return g;
  };
  networkManager.onFlagUpdate = (flags) => {
    for (const f of flags) {
      const g = ensureFlagMesh(f.team);
      g.position.set(f.pos.x, f.pos.y, f.pos.z);
      if (f.state === 'carried' && f.carrier) flagCarriers.set(f.team, f.carrier);
      else flagCarriers.delete(f.team);
      deps.world.flagStates[f.team] = f.state;
    }
  };
}
