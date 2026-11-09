import * as THREE from 'three';

import {
  GNAT_SPAWN_INTERVAL, GNAT_SPAWN_MIN, GNAT_SPAWN_MAX,
  GNAT_CLOUD_MIN, GNAT_CLOUD_MAX, GNAT_ORBIT_ALT,
  GNAT_NIP_DAMAGE, GNAT_NIP_FORCE, GNAT_NIP_DIST,
  SEEKER_SPAWN_INTERVAL, SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX,
  SEEKER_STING_DAMAGE, SEEKER_STING_FORCE, SEEKER_STING_DIST,
  RAKK_SPAWN_INTERVAL, RAKK_SPAWN_MIN, RAKK_SPAWN_MAX,
  RAKK_CLAW_DAMAGE, RAKK_CLAW_FORCE, RAKK_CLAW_DIST,
  STRIFER_SPAWN_INTERVAL, STRIFER_SPAWN_MIN, STRIFER_SPAWN_MAX,
  STRIFER_BOLT_DAMAGE, STRIFER_BOLT_FORCE,
} from '../../core/config.js';
import { simRand } from '../../../../shared/simRand.js';
import * as sfx from '../../core/sfx.js';
import type { Species } from '../speciesKit.js';
import { PROFILES } from '../targeting.js';
import { Gnat } from '../../entities/Gnat.js';
import { Seeker } from '../../entities/Seeker.js';
import { Rakk } from '../../entities/Rakk.js';
import { Strifer } from '../../entities/Strifer.js';
import type { Buzzard } from '../../entities/Buzzard.js';
import type { SpeciesCtx } from './context.js';
import { capFor } from './ambientCaps.js';

// Air family - gnats (boid clouds), seekers (darting stingers), rakks
// (swooping cliff-racers). Shared shape: ringPos spawn, one damage callback,
// flyer aggro profile.
export function createFlyerSpecies({ deps, kit, targets }: SpeciesCtx) {
  const { scene } = deps;
  const { rollUber, ringPos, hurtPlayer, bite, aggroFor, aggroVelFor, kickTrail, updateSpecies, atCap } = kit;

  const gnats: Gnat[] = [];
  // Live gnat clouds - members share these objects; centers chase the player
  const gnatClouds: { center: THREE.Vector3; nipGate: number }[] = [];
  const seekers: Seeker[] = [];
  const rakks: Rakk[] = [];
  const strifers: Strifer[] = []; const buzzards: Buzzard[] = []; // wire-owned — server `creatures` pops mint them; no ambient spawn
  const _gnatTarget = new THREE.Vector3();

  // ---- Gnats (boid harasser cloud — orbits you, darts for nips) ----
  function spawnGnatCloud(uber?: boolean): void {
    if (atCap(gnats, capFor('gnat'))) {return;}
    const u = uber ?? rollUber();
    const base = ringPos(GNAT_SPAWN_MIN, GNAT_SPAWN_MAX);
    const player = deps.lazyPlayer();
    const cloud = {
      center: new THREE.Vector3(
        player.pos.x + (simRand() - 0.5) * 30,
        deps.lazyTerrain().getHeight(base.x, base.z) + GNAT_ORBIT_ALT + 8,
        player.pos.z + (simRand() - 0.5) * 30,
      ),
      nipGate: 0,
    };
    gnatClouds.push(cloud);
    // Uber roll = a QUEEN — one big tanky gnat with a small escort retinue,
    // not a whole cloud of queens.
    const n = u
      ? 1 + Math.floor(simRand() * 3) + 2      // queen + 2-4 escorts
      : GNAT_CLOUD_MIN + Math.floor(simRand() * (GNAT_CLOUD_MAX - GNAT_CLOUD_MIN + 1));
    for (let k = 0; k < n; k += 1) {
      if (atCap(gnats, capFor('gnat'))) {break;}
      const queen = u && k === 0; // firstborn is the queen
      const g = new Gnat(scene, deps.lazyTerrain(), cloud.center.clone().add(new THREE.Vector3(
        (simRand() - 0.5) * 8, (simRand() - 0.5) * 4, (simRand() - 0.5) * 8)), queen);
      g.joinCloud(cloud);
      g.onNip = (gn): boolean => bite(gn, GNAT_NIP_FORCE, GNAT_NIP_DAMAGE, 'drained by gnats', { dmg: 3, text: 'drained by the gnat queen' }, GNAT_NIP_DIST + 2);
      gnats.push(g);
      targets.push(g);
    }
  }

  const gnatSpecies: Species<Gnat> = {
    list: gnats, interval: GNAT_SPAWN_INTERVAL, t: -25,
    spawn: spawnGnatCloud,
    tick: (g, dt): void => g.update(dt, deps.lazyTerrain(), aggroFor(g, g.pos, dt, PROFILES.flyer)),
  };
  function updateGnats(dt: number): void {
    // Cloud centers stalk the player loosely — the swarm hovers over you
    // and drifts along as you move, never quite settling. Each cloud gets
    // its own brain: in shared PvE a cloud picks a victim and stalks THEM.
    for (let i = gnatClouds.length - 1; i >= 0; i -= 1) {
      const c = gnatClouds[i]!;
      // Retire clouds with no living members
      if (!gnats.some((g): boolean => !g.dead && g.cloud === c)) {
        gnatClouds.splice(i, 1);
        continue;
      }
      const t = aggroFor(c, c.center, dt, PROFILES.flyer);
      const gy = deps.lazyTerrain().getHeight(t.x, t.z);
      _gnatTarget.set(t.x, Math.max(gy, t.y) + GNAT_ORBIT_ALT, t.z);
      c.center.lerp(_gnatTarget, Math.min(1, dt * 0.5)); // lazy stalk
    }
    updateSpecies(gnatSpecies, dt);
  }

  // ---- Seekers (airborne sting enemies — telegraphed darts) ----
  function spawnSeeker(uber?: boolean): void {
    if (atCap(seekers, capFor('seeker'))) {return;}
    const u = uber ?? rollUber();
    const s = new Seeker(scene, deps.lazyTerrain(), ringPos(SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX), u);
    s.onSting = (sk): boolean => bite(sk, SEEKER_STING_FORCE, SEEKER_STING_DAMAGE, 'stung to death by a seeker', { force: 1.5, text: 'run through by a lancer' }, SEEKER_STING_DIST + 1);
    seekers.push(s);
    targets.push(s);
  }

  const seekerSpecies: Species<Seeker> = {
    list: seekers, interval: SEEKER_SPAWN_INTERVAL, t: -40,
    spawn: spawnSeeker,
    tick: (s, dt): void => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.flyer), aggroVelFor(s)); kickTrail(s, dt); },
  };
  function updateSeekers(dt: number): void { updateSpecies(seekerSpecies, dt); }

  // ---- Rakks (circling cliff-racers — fold-and-swoop passes) ----
  function spawnRakk(uber?: boolean): void {
    if (deps.lazyDemoManager()?.isPlaying) {return;}
    if (atCap(rakks, capFor('rakk'))) {return;}
    const u = uber ?? rollUber();
    const r = new Rakk(scene, deps.lazyTerrain(), ringPos(RAKK_SPAWN_MIN, RAKK_SPAWN_MAX), u);
    r.onClawHit = (rk): void => {
      const hit = hurtPlayer(rk.pos, RAKK_CLAW_FORCE * (rk.uber ? 1.5 : 1), RAKK_CLAW_DAMAGE * (rk.uber ? 2 : 1),
        rk.uber ? 'carried off by an elder rakk' : 'shredded by a rakk', rk.radius + RAKK_CLAW_DIST + 1, rk);
      if (hit && rk.uber) {
        // Elder talons hoist you — a claw hit throws you skyward, which is
        // worse than the damage when you're already committed to a ski line.
        const player = deps.lazyPlayer();
        player.vel.y += 14;
        player.vel.addScaledVector(rk.vel, 0.3);
      }
    };
    r.onDive = (rk): void => { deps.lazyEffects().spawnJumpDust(rk.pos); sfx.enemyCue(rk.pos, 'dart'); }; // wing-tuck puff — silhouette cue
    rakks.push(r);
    targets.push(r);
  }

  const rakkSpecies: Species<Rakk> = {
    list: rakks, interval: RAKK_SPAWN_INTERVAL, t: -80,
    spawn: spawnRakk,
    tick: (r, dt): void => { r.update(dt, deps.lazyTerrain(), aggroFor(r, r.pos, dt, PROFILES.flyer)); kickTrail(r, dt); },
  };
  function updateRakks(dt: number): void { updateSpecies(rakkSpecies, dt); }

  // ---- Strifers (standoff strafing drones — orbit, hover, bolt volley) ----
  function spawnStrifer(uber?: boolean): void {
    if (deps.lazyDemoManager()?.isPlaying) {return;}
    if (atCap(strifers, capFor('strifer'))) {return;}
    const u = uber ?? rollUber();
    const st = new Strifer(scene, deps.lazyTerrain(), ringPos(STRIFER_SPAWN_MIN, STRIFER_SPAWN_MAX), u);
    st.onBoltHit = (x, pos): boolean => hurtPlayer(pos, STRIFER_BOLT_FORCE, STRIFER_BOLT_DAMAGE * (x.uber ? 2 : 1),
      x.uber ? 'raked by an elder strifer' : 'shot down by a strifer', 3, x);
    st.onBoltLand = (pos): void => deps.lazyEffects().spawnImpact(pos, new THREE.Vector3(0, 1, 0));
    st.onFire = (x): void => sfx.enemyCue(x.pos, 'zap');
    strifers.push(st);
    targets.push(st);
  }

  const striferSpecies: Species<Strifer> = {
    list: strifers, interval: STRIFER_SPAWN_INTERVAL, t: -30,
    spawn: spawnStrifer,
    tick: (st, dt): void => { st.update(dt, deps.lazyTerrain(), aggroFor(st, st.pos, dt, PROFILES.flyer), aggroVelFor(st)); kickTrail(st, dt); },
  };
  function updateStrifers(dt: number): void { updateSpecies(striferSpecies, dt); }

  const buzzardSpecies: Species<Buzzard> = { list: buzzards, interval: Number.POSITIVE_INFINITY, t: 0, spawn: (): void => undefined, tick: (b, dt): void => { b.update(dt, deps.lazyTerrain(), aggroFor(b, b.pos, dt, PROFILES.flyer)); } }; // wire owns it — never ambient
  function updateBuzzards(dt: number): void { updateSpecies(buzzardSpecies, dt); }
  return {
    gnats, gnatClouds, seekers, rakks, strifers, buzzards,
    spawnGnatCloud, spawnSeeker, spawnRakk, spawnStrifer,
    updateGnats, updateSeekers, updateRakks, updateStrifers, updateBuzzards,
  };
}
