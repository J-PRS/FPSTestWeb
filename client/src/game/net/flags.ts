// Server-owned CTF flags — dumb renderers: pole+banner meshes that just
// follow flagUpdate positions. All rules live in RoomFlags server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';

const _burstPos = new THREE.Vector3();

export function wireFlags(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;

  // Carried flags get no position stream (server stopped broadcasting it) —
  // remotes.ts tickFlagMarkers pins the mesh to the carrier's rendered body
  // every frame instead, which is smoother than any wire rate anyway.
  const flagMeshes = new Map<string, THREE.Group>();
  // Teams already in 'dropped' on the previous update — the drop frame
  // itself snaps (mesh is at the corpse anyway); only continued-flight
  // updates ease toward the wire pos.
  const wasDropped = new Set<string>();
  const ensureFlagMesh = (team: TeamId): THREE.Group => {
    let g = flagMeshes.get(team);
    if (g) return g;
    g = new THREE.Group();
    const teamColor = team === 'alpha' ? 0x55aaff : 0xff8855;
    // The dropped flag IS this ball on the ground — same nugget look as a
    // pickup gem — with the pole planted upright through it. Always shown:
    // on the stand it reads as the base the pole grows out of.
    const base = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.4, 0),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor).multiplyScalar(1.4) }));
    base.position.y = 0.4;
    base.position.y = 0.4;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 4, 6),
      new THREE.MeshBasicMaterial({ color: 0x888888 }));
    pole.position.y = 2;
    const banner = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.2, 4),
      new THREE.MeshBasicMaterial({ color: teamColor }));
    banner.position.set(0.55, 3.4, 0);
    g.add(base, pole, banner);
    // No onBeforeRender hook here — three.js never invokes it on a bare
    // Group (only renderable objects reach the render list). The per-frame
    // carrier pin + flight lerp lives in remotes.ts tickFlagMarkers.
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
  const burst = (f: { team: TeamId; pos: { x: number; y: number; z: number } }, scale: number) =>
    burstAt(f.pos, scale, f.team);
  const burstAt = (pos: { x: number; y: number; z: number }, scale: number, team: TeamId) => {
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), _burstPos.set(pos.x, pos.y + 1.2, pos.z),
      false, 0, deps.lazyTerrain(), scale, TEAM_COLORS[team]));
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
    // The 'home' update's pos is the flag's OWN stand — for a capture the
    // celebration belongs at the cap spot, i.e. the carrier's position at
    // cap time. marker.carrier still holds the id (it clears below).
    if (scored) {
      const capAt = carrierPos(f.team) ?? f.pos;
      burstAt(capAt, 2.4, f.team);
      burst(f, 1.0); // return puff back at the stand
    } else {
      burst(f, 1.4);
    }
    log(scored ? `${carrierName ?? 'Someone'} captured the ${f.team} flag` : `${f.team} flag returned`);
  };
  /** Carrier's live rendered pos — the cap spot on a scored transition. */
  const carrierPos = (team: TeamId): THREE.Vector3 | null => {
    const id = deps.world.flagMarkers.get(team)?.carrier;
    if (!id) return null;
    return id === networkManager.getLocalPlayerId()
      ? deps.lazyPlayer().pos
      : deps.world.remotePlayers.get(id)?.pos ?? null;
  };

  networkManager.onFlagUpdate = (flags) => {
    // An empty roster (room hop out of a CTF match, or gameState with no
    // flags) tears the meshes and HUD diamonds down.
    const live = new Set(flags.map(f => f.team));
    for (const team of flagMeshes.keys()) { // Map delete-during-iterate is safe
      if (live.has(team as TeamId)) continue;
      deps.lazyScene().remove(flagMeshes.get(team)!);
      flagMeshes.delete(team);
      wasDropped.delete(team);
      prevState.delete(team);
      deps.world.flagMarkers.delete(team as TeamId);
      deps.lazyHud().removePlayerIndicator(`flag:${team}`);
      delete deps.world.flagStates[team as TeamId];
    }
    for (const f of flags) {
      callout(f);
      const g = ensureFlagMesh(f.team);
      let marker = deps.world.flagMarkers.get(f.team);
      if (!marker || marker.mesh !== g) {
        marker = { mesh: g, carrier: null, wirePos: new THREE.Vector3() };
      }
      marker.wirePos.set(f.pos.x, f.pos.y, f.pos.z);
      // 'dropped' streams 20Hz while the flag flies — don't snap the mesh
      // mid-flight, tickFlagMarkers eases toward wirePos. The drop frame
      // itself and every other state snap as before.
      if (!(f.state === 'dropped' && wasDropped.has(f.team))) {
        g.position.copy(marker.wirePos);
      }
      if (f.state === 'dropped') wasDropped.add(f.team);
      else wasDropped.delete(f.team);
      marker.carrier = f.state === 'carried' ? f.carrier : null;
      deps.world.flagStates[f.team] = f.state;
      // Per-frame HUD diamond + mesh drive read this — tickFlagMarkers
      // runs every frame regardless of frustum, unlike a render hook.
      deps.world.flagMarkers.set(f.team, marker);
    }
  };
}
