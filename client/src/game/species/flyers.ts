import * as THREE from 'three';

import {
  GNAT_MAX, GNAT_SPAWN_INTERVAL, GNAT_SPAWN_MIN, GNAT_SPAWN_MAX,
  GNAT_CLOUD_MIN, GNAT_CLOUD_MAX, GNAT_ORBIT_ALT,
  GNAT_NIP_DAMAGE, GNAT_NIP_FORCE, GNAT_NIP_DIST,
  SEEKER_MAX, SEEKER_SPAWN_INTERVAL, SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX,
  SEEKER_STING_DAMAGE, SEEKER_STING_FORCE, SEEKER_STING_DIST,
  RAKK_MAX, RAKK_SPAWN_INTERVAL, RAKK_SPAWN_MIN, RAKK_SPAWN_MAX,
  RAKK_CLAW_DAMAGE, RAKK_CLAW_FORCE, RAKK_CLAW_DIST,
} from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import type { Species } from '../speciesKit.js';
import { PROFILES } from '../targeting.js';
import { Gnat } from '../../entities/Gnat.js';
import { Seeker } from '../../entities/Seeker.js';
import { Rakk } from '../../entities/Rakk.js';
import type { SpeciesCtx } from './context.js';

// Air family — gnats (boid clouds), seekers (darting stingers), rakks
// (swooping cliff-racers). Shared shape: ringPos spawn, one damage callback,
// flyer aggro profile.
export function createFlyerSpecies({ deps, kit, targets }: SpeciesCtx) {
  const { scene } = deps;
  const { rollUber, ringPos, hurtPlayer, aggroFor, aggroVelFor, kickTrail, updateSpecies, atCap } = kit;

  const gnats: Gnat[] = [];
  // Live gnat clouds — members share these objects; centers chase the player
  const gnatClouds: { center: THREE.Vector3; nipGate: number }[] = [];
  const seekers: Seeker[] = [];
  const rakks: Rakk[] = [];
  const _gnatTarget = new THREE.Vector3();

  // ---- Gnats (boid harasser cloud — orbits you, darts for nips) ----
  function spawnGnatCloud(uber?: boolean): void {
    if (atCap(gnats, GNAT_MAX)) return;
    const u = uber ?? rollUber();
    const base = ringPos(GNAT_SPAWN_MIN, GNAT_SPAWN_MAX);
    const player = deps.lazyPlayer();
    const cloud = {
      center: new THREE.Vector3(
        player.pos.x + (Math.random() - 0.5) * 30,
        deps.lazyTerrain().getHeight(base.x, base.z) + GNAT_ORBIT_ALT + 8,
        player.pos.z + (Math.random() - 0.5) * 30,
      ),
      nipGate: 0,
    };
    gnatClouds.push(cloud);
    // Uber roll = a QUEEN — one big tanky gnat with a small escort retinue,
    // not a whole cloud of queens.
    const n = u
      ? 1 + Math.floor(Math.random() * 3) + 2      // queen + 2-4 escorts
      : GNAT_CLOUD_MIN + Math.floor(Math.random() * (GNAT_CLOUD_MAX - GNAT_CLOUD_MIN + 1));
    for (let k = 0; k < n; k++) {
      if (atCap(gnats, GNAT_MAX)) break;
      const queen = u && k === 0; // firstborn is the queen
      const g = new Gnat(scene, deps.lazyTerrain(), cloud.center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8)), queen);
      g.joinCloud(cloud);
      g.onNip = (gn) => hurtPlayer(gn.pos,
        GNAT_NIP_FORCE * (gn.uber ? 2 : 1), GNAT_NIP_DAMAGE * (gn.uber ? 3 : 1),
        gn.uber ? 'drained by the gnat queen' : 'drained by gnats', gn.radius + GNAT_NIP_DIST + 2, gn);
      gnats.push(g);
      targets.push(g);
    }
  }

  const gnatSpecies: Species<Gnat> = {
    list: gnats, interval: GNAT_SPAWN_INTERVAL, t: -25,
    spawn: spawnGnatCloud,
    tick: (g, dt) => g.update(dt, deps.lazyTerrain(), aggroFor(g, g.pos, dt, PROFILES.flyer)),
  };
  function updateGnats(dt: number): void {
    // Cloud centers stalk the player loosely — the swarm hovers over you
    // and drifts along as you move, never quite settling. Each cloud gets
    // its own brain: in shared PvE a cloud picks a victim and stalks THEM.
    for (let i = gnatClouds.length - 1; i >= 0; i--) {
      const c = gnatClouds[i]!;
      // Retire clouds with no living members
      if (!gnats.some(g => !g.dead && g.cloud === c)) {
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
    if (atCap(seekers, SEEKER_MAX)) return;
    const u = uber ?? rollUber();
    const s = new Seeker(scene, deps.lazyTerrain(), ringPos(SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX), u);
    s.onSting = (sk) => hurtPlayer(sk.pos, SEEKER_STING_FORCE * (sk.uber ? 1.5 : 1),
      SEEKER_STING_DAMAGE * (sk.uber ? 2 : 1),
      sk.uber ? 'run through by a lancer' : 'stung to death by a seeker', sk.radius + SEEKER_STING_DIST + 1, sk);
    seekers.push(s);
    targets.push(s);
  }

  const seekerSpecies: Species<Seeker> = {
    list: seekers, interval: SEEKER_SPAWN_INTERVAL, t: -40,
    spawn: spawnSeeker,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.flyer), aggroVelFor(s)); kickTrail(s, dt); },
  };
  function updateSeekers(dt: number): void { updateSpecies(seekerSpecies, dt); }

  // ---- Rakks (circling cliff-racers — fold-and-swoop passes) ----
  function spawnRakk(uber?: boolean): void {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (atCap(rakks, RAKK_MAX)) return;
    const u = uber ?? rollUber();
    const r = new Rakk(scene, deps.lazyTerrain(), ringPos(RAKK_SPAWN_MIN, RAKK_SPAWN_MAX), u);
    r.onClawHit = (rk) => {
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
    r.onDive = (rk) => { deps.lazyEffects().spawnJumpDust(rk.pos); sfx.enemyCue(rk.pos, 'dart'); }; // wing-tuck puff — silhouette cue
    rakks.push(r);
    targets.push(r);
  }

  const rakkSpecies: Species<Rakk> = {
    list: rakks, interval: RAKK_SPAWN_INTERVAL, t: -80,
    spawn: spawnRakk,
    tick: (r, dt) => { r.update(dt, deps.lazyTerrain(), aggroFor(r, r.pos, dt, PROFILES.flyer)); kickTrail(r, dt); },
  };
  function updateRakks(dt: number): void { updateSpecies(rakkSpecies, dt); }

  return {
    gnats, gnatClouds, seekers, rakks,
    spawnGnatCloud, spawnSeeker, spawnRakk,
    updateGnats, updateSeekers, updateRakks,
  };
}
