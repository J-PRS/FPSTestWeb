// Server-owned CTF flags — dumb renderers: pole+banner meshes that just
// follow flagUpdate positions. All rules live in RoomFlags server-side.

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import { mkFlagStand, FLAG_STAND_TOP } from '../../structures/structures.js';
import { mkFlagMesh } from '../ctfFlags.js';
import { flagReturnFx } from '../flagFx.js';

const _burstPos = new THREE.Vector3();

export interface FlagVis { flag: THREE.Group; stand: THREE.Group }

/** Stand + flag mesh pair. The STAND is just the gem socket — planted at
 *  home forever, a bare socket is how you read "flag's out". The FLAG
 *  (pole + banner + finial) is the piece that gets ripped out, carried,
 *  dropped, and returned; home state reseats the pole in the socket so
 *  the pair reads as one complete flag. */
function buildFlagVis(team: TeamId): FlagVis {
  const teamColor = team === 'alpha' ? 0x55aaff : 0xff8855;
  const stand = mkFlagStand(teamColor);
  const base = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.4, 0),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor).multiplyScalar(1.4) }));
  base.position.y = FLAG_STAND_TOP + 0.07; // gem socket in the well
  stand.add(base);
  stand.visible = false; // until the wire's home plants it
  // The real banner mesh — same origin-at-pole-base convention this
  // file's seating math already uses; the old hand-rolled cone pennant
  // rendered alongside it as a second flag.
  return { flag: mkFlagMesh(team), stand };
}

/** Rabbit announcements — the flag is neutral, so no OUR/ENEMY split:
 *  what matters is WHO the rabbit is. First-blood spawn reads as a
 *  dropped-flag banner ("FLAG LOOSE — GRAB IT"). */
function rabbitCallout(
  f: { state: string; carrier: string | null; pos: { x: number; y: number; z: number } },
  iAmCarrier: boolean, carrierName: string | null,
  burst: (scale: number) => void,
  frag: { show(t: string): void },
  log: (t: string) => void,
): void {
  if (f.state === 'carried') {
    frag.show(iAmCarrier ? 'YOU ARE THE RABBIT!' : `${carrierName ?? 'Someone'} IS THE RABBIT`);
    sfx.flagCue('taken', iAmCarrier);
    burst(1.4);
    log(`${iAmCarrier ? 'You are' : `${carrierName ?? 'Someone'} is`} the rabbit`);
  } else if (f.state === 'dropped') {
    frag.show('FLAG LOOSE — GRAB IT');
    sfx.flagCue('dropped', false);
    burst(1.0);
    log('the rabbit flag is loose');
  } else if (f.state === 'home') {
    frag.show('FLAG RETURNED');
    sfx.flagCue('returned', false);
    burst(1.4);
    flagReturnFx(_burstPos.set(f.pos.x, f.pos.y, f.pos.z), null, undefined);
    log('the flag returned to the stand');
  }
}

interface CalloutCtx {
  prev?: string; mine: boolean; iAmCarrier: boolean; carrierName: string | null;
  frag: { show(t: string): void }; log(t: string): void;
  burst(scale: number): void; homeCallout(): void;
}

/** Team-mode transitions: carried = grab, dropped = fumble, home =
 *  capture (carried→home) or return (dropped→home — the homing is a
 *  closure because it owns the cap-spot ceremony). */
function ctfCallout(
  f: { team: TeamId; state: string; carrier: string | null },
  c: CalloutCtx,
): void {
  if (f.state === 'carried') {
    c.frag.show(c.iAmCarrier ? 'YOU HAVE THE FLAG!' : c.mine ? 'OUR FLAG TAKEN!' : 'ENEMY FLAG TAKEN!');
    sfx.flagCue('taken', c.mine);
    c.burst(1.4);
    c.log(`${c.iAmCarrier ? 'You' : (c.carrierName ?? 'Someone')} took the ${f.team} flag`);
  } else if (f.state === 'dropped') {
    c.frag.show(c.mine ? 'OUR FLAG DROPPED' : 'ENEMY FLAG DROPPED');
    sfx.flagCue('dropped', c.mine);
    c.burst(1.0);
    c.log(`${f.team} flag dropped`);
  } else if (f.state === 'home') {
    c.homeCallout();
  }
}

export function wireFlags(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;

  // Carried flags get no position stream (server stopped broadcasting it) —
  // remotes.ts tickFlagMarkers pins the mesh to the carrier's rendered body
  // every frame instead, which is smoother than any wire rate anyway.
  const flagMeshes = new Map<string, FlagVis>();
  // Teams already in 'dropped' on the previous update — the drop frame
  // itself snaps (mesh is at the corpse anyway); only continued-flight
  // updates ease toward the wire pos.
  const wasDropped = new Set<string>();
  const ensureFlagMesh = (team: TeamId): FlagVis => {
    let vis = flagMeshes.get(team);
    if (vis) return vis;
    // No onBeforeRender hook here — three.js never invokes it on a bare
    // Group (only renderable objects reach the render list). The per-frame
    // carrier pin + flight lerp lives in remotes.ts tickFlagMarkers.
    vis = buildFlagVis(team);
    deps.lazyScene().add(vis.stand, vis.flag);
    flagMeshes.set(team, vis);
    return vis;
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
  const callout = (f: { team: TeamId; state: string; carrier: string | null; pos: { x: number; y: number; z: number } }, hush: boolean) => {
    const prev = prevState.get(f.team);
    prevState.set(f.team, f.state);
    const rabbit = deps.world.mode === 'rabbit';
    // Rabbit's flag enters play already 'dropped' — first blood spawns
    // it — so its very first update IS the announce-worthy transition.
    if (prev === f.state || (prev === undefined && !(rabbit && f.state !== 'home'))) return;
    // Match-reset →home transitions are endCleanup, not a play — the
    // server's flags.reset() fakes cap/return transitions otherwise.
    if (hush && f.state === 'home') return;
    const mine = f.team === deps.world.localTeam;
    const iAmCarrier = f.carrier === networkManager.getLocalPlayerId();
    const frag = deps.fragMessages;
    const log = (text: string) => deps.lazyHud().logEvent(text, mine ? 'mine' : 'foe');
    const carrierName = f.carrier?.replace('bot:', '') ?? null;
    if (rabbit) {
      rabbitCallout(f, iAmCarrier, carrierName, (s) => burst(f, s), frag, log);
      return;
    }
    ctfCallout(f, { prev, mine, iAmCarrier, carrierName, frag, log, burst: (s) => burst(f, s), homeCallout: () => homeCallout(f, prev, mine, frag, log, carrierName) });
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
      // wirePos still holds the dropped spot — callout runs before
      // applyFlagUpdate overwrites it — so the streak can fly the
      // actual return path the flag just took.
      const from = deps.world.flagMarkers.get(f.team)?.wirePos ?? null;
      flagReturnFx(_burstPos.set(f.pos.x, f.pos.y, f.pos.z), f.team, from);
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
    // Post-matchStart broadcast carries the reset transitions — hush
    // exactly this update, then announce edges normally again.
    const hush = deps.world.flagHomeHush;
    deps.world.flagHomeHush = false;
    reconcileReplicas(flagMeshes, flags, {
      rowId: (f) => f.team,
      ensure: (f) => ensureFlagMesh(f.team),
      apply: (_vis, f) => applyFlagUpdate(f, hush),
      reap: (vis, team) => {
        deps.lazyScene().remove(vis.flag, vis.stand);
        wasDropped.delete(team);
        prevState.delete(team);
        deps.world.flagMarkers.delete(team as TeamId);
        deps.lazyHud().removePlayerIndicator(`flag:${team}`);
        deps.lazyHud().removePlayerIndicator(`stand:${team}`);
        delete deps.world.flagStates[team as TeamId];
      },
    });
  };

  const applyFlagUpdate = (f: { team: TeamId; pos: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }, hush = false): void => {
    callout(f, hush);
    const vis = ensureFlagMesh(f.team);
    let marker = deps.world.flagMarkers.get(f.team);
    if (!marker || marker.mesh !== vis.flag) {
      marker = { mesh: vis.flag, stand: vis.stand, home: new THREE.Vector3(), homeKnown: false, carrier: null, wirePos: new THREE.Vector3() };
    }
    // Stand anchor: the wire's home is authoritative; a 'home'-state
    // pos is the same spot — the fallback covers a legacy snapshot.
    if (f.home) {
      marker.home.set(f.home.x, f.home.y, f.home.z);
      marker.homeKnown = true;
    } else if (f.state === 'home') {
      marker.home.set(f.pos.x, f.pos.y, f.pos.z);
      marker.homeKnown = true;
    }
    if (marker.homeKnown) {
      vis.stand.visible = true;
      vis.stand.position.copy(marker.home);
    }
    marker.wirePos.set(f.pos.x, f.pos.y, f.pos.z);
    // The wire's home is ground level; the pole seats ON the platform
    // deck — tickFlagMarkers lerps to wirePos, so lift the target.
    if (f.state === 'home') marker.wirePos.y += FLAG_STAND_TOP;
    // 'dropped' streams 20Hz while the flag flies — don't snap the mesh
    // mid-flight, tickFlagMarkers eases toward wirePos. The drop frame
    // itself and every other state snap as before.
    if (!(f.state === 'dropped' && wasDropped.has(f.team))) {
      vis.flag.position.copy(marker.wirePos);
    }
    if (f.state === 'dropped') wasDropped.add(f.team);
    else wasDropped.delete(f.team);
    deps.lazyDemoManager?.()?.recordFlagUpdate(f.team, f.state, f.pos, f.carrier);
    marker.carrier = f.state === 'carried' ? f.carrier : null;
    deps.world.flagStates[f.team] = f.state;
    // Per-frame HUD diamond + mesh drive read this — tickFlagMarkers
    // runs every frame regardless of frustum, unlike a render hook.
    deps.world.flagMarkers.set(f.team, marker);
  };
}
