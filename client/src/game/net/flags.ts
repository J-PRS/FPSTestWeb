// Server-owned CTF flags — dumb renderers: pole+banner meshes that just
// follow flagUpdate positions. All rules live in RoomFlags server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';

const _flagMarker = new THREE.Vector3();
const _burstPos = new THREE.Vector3();

export function wireFlags(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;

  // Carried flags get no position stream (server stopped broadcasting it) —
  // the mesh pins to the carrier's rendered position at draw time instead,
  // which is smoother than any wire rate anyway.
  const flagMeshes = new Map<string, THREE.Group>();
  const flagCarriers = new Map<string, string>();
  const ensureFlagMesh = (team: TeamId): THREE.Group => {
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
    g.onBeforeRender = (_renderer, _scene, camera) => {
      const carrier = flagCarriers.get(team);
      if (carrier) {
        if (carrier === networkManager.getLocalPlayerId()) {
          g.position.copy(deps.lazyPlayer().pos);
        } else {
          const rp = deps.world.remotePlayers.get(carrier);
          if (rp) g.position.copy(rp.pos);
        }
        g.position.y += 0.4; // ride the shoulders, not the boots
      }
      // Flag marker — the through-terrain diamond. DOM overlay, so this is
      // legal inside the render callback (position is final by now).
      // The indicator path adds +1.0 for a player capsule; the flag wants
      // its diamond at the pole tip (~4m), so lift the anchor 3.4 more.
      deps.lazyHud().updateFlagIndicator(`flag:${team}`, _flagMarker.set(g.position.x, g.position.y + 3.4, g.position.z), camera, team);
    };
    deps.lazyScene().add(g);
    flagMeshes.set(team, g);
    return g;
  };
  // Center-screen callouts on flag transitions — the Tribes "FLAG TAKEN"
  // beat. Previous state decides what happened: →carried = grab,
  // carried→home = capture, dropped→home = return/reset.
  const prevState = new Map<string, string>();
  // Team-colored blast where the flag just changed hands — the grab pop,
  // the drop puff, and the big capture detonation read instantly without
  // watching the killfeed.
  const burst = (f: { team: TeamId; pos: { x: number; y: number; z: number } }, scale: number) => {
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), _burstPos.set(f.pos.x, f.pos.y + 1.2, f.pos.z),
      false, 0, deps.lazyTerrain(), scale, TEAM_COLORS[f.team]));
  };
  const callout = (f: { team: TeamId; state: string; carrier: string | null; pos: { x: number; y: number; z: number } }) => {
    const prev = prevState.get(f.team);
    prevState.set(f.team, f.state);
    if (prev === f.state || prev === undefined) return;
    const mine = f.team === deps.world.localTeam;
    const iAmCarrier = f.carrier === networkManager.getLocalPlayerId();
    const frag = deps.fragMessages;
    const log = (text: string) => deps.lazyHud().logEvent(text, mine ? 'mine' : 'foe');
    const carrierName = f.carrier?.replace('bot:', '') ?? null;
    if (f.state === 'carried') {
      if (iAmCarrier) frag.show('YOU HAVE THE FLAG!');
      else frag.show(mine ? 'OUR FLAG TAKEN!' : 'ENEMY FLAG TAKEN!');
      sfx.flagCue('taken', mine);
      burst(f, 1.4);
      log(`${iAmCarrier ? 'You' : (carrierName ?? 'Someone')} took the ${f.team} flag`);
    } else if (f.state === 'dropped') {
      frag.show(mine ? 'OUR FLAG DROPPED' : 'ENEMY FLAG DROPPED');
      sfx.flagCue('dropped', mine);
      burst(f, 1.0);
      log(`${f.team} flag dropped`);
    } else if (f.state === 'home') {
      homeCallout(f, prev, mine, frag, log, carrierName);
    }
  };
  /** Home transition: carried→home = capture, dropped→home = return. */
  const homeCallout = (
    f: { team: TeamId; pos: { x: number; y: number; z: number } },
    prev: string | undefined, mine: boolean,
    frag: { show(t: string): void },
    log: (t: string) => void,
    carrierName: string | null,
  ) => {
    const scored = prev === 'carried';
    frag.show(scored ? (mine ? 'THEY SCORED!' : 'CAPTURED!') : (mine ? 'FLAG RETURNED' : 'ENEMY FLAG RETURNED'));
    sfx.flagCue(scored ? 'captured' : 'returned', mine);
    burst(f, scored ? 2.4 : 1.4);
    log(scored ? `${carrierName ?? 'Someone'} captured the ${f.team} flag` : `${f.team} flag returned`);
  };

  networkManager.onFlagUpdate = (flags) => {
    // An empty roster (room hop out of a CTF match, or gameState with no
    // flags) tears the meshes and HUD diamonds down.
    const live = new Set(flags.map(f => f.team));
    for (const team of flagMeshes.keys()) { // Map delete-during-iterate is safe
      if (live.has(team as TeamId)) continue;
      deps.lazyScene().remove(flagMeshes.get(team)!);
      flagMeshes.delete(team);
      flagCarriers.delete(team);
      prevState.delete(team);
      deps.lazyHud().removePlayerIndicator(`flag:${team}`);
      delete deps.world.flagStates[team as TeamId];
    }
    for (const f of flags) {
      callout(f);
      const g = ensureFlagMesh(f.team);
      g.position.set(f.pos.x, f.pos.y, f.pos.z);
      if (f.state === 'carried' && f.carrier) flagCarriers.set(f.team, f.carrier);
      else flagCarriers.delete(f.team);
      deps.world.flagStates[f.team] = f.state;
    }
  };
}
