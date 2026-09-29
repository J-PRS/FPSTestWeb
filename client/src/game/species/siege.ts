import * as THREE from 'three';

import {
  TURRET_MAX, TURRET_SPAWN_INTERVAL, TURRET_SPAWN_MIN, TURRET_SPAWN_MAX, TURRET_BOLT_DAMAGE,
  OVERLORD_MAX, OVERLORD_SPAWN_INTERVAL, OVERLORD_SPAWN_MIN, OVERLORD_SPAWN_MAX,
  MINE_MAX, MINE_DAMAGE_MAX, MINE_KNOCKBACK,
  BANELING_MAX, BANELING_DAMAGE_MAX, BANELING_KNOCKBACK,
  TOTEM_MAX, TOTEM_SPAWN_INTERVAL, TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX,
  TOTEM_BOLT_DAMAGE, UBER_TOTEM_MAX, UBER_TOTEM_BOLT_DAMAGE,
  ROCKET_RADIUS, // Explosion VFX scale reference — blast visuals normalize to it
} from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import type { Species } from '../speciesKit.js';
import type { Targetable } from '../../entities/balls.js';
import { PROFILES } from '../targeting.js';
import { Turretter, type Bolt } from '../../entities/Turretter.js';
import { Totem } from '../../entities/Totem.js';
import { Overlord } from '../../entities/Overlord.js';
import { Mine } from '../../entities/Mine.js';
import { Baneling } from '../../entities/Baneling.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import type { SpeciesCtx } from './context.js';
import { capFor } from './ambientCaps.js';

type SiegeKit = Pick<SpeciesCtx['kit'],
  'burrow' | 'blastAtPlayer' | 'hurtPlayer' | 'boltPop' | 'rollUber' | 'ringPos' | 'atCap' | 'removeTarget'>;

interface HasDead { dead: boolean; dispose(): void }
function reapSpecies<T extends HasDead & Targetable>(list: T[], targets: SpeciesCtx['targets'], _dt: number, tick: (e: T) => void): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    tick(e);
    if (e.dead) {
      e.dispose();
      const ti = targets.indexOf(e);
      if (ti >= 0) targets.splice(ti, 1);
      list.splice(i, 1);
    }
  }
}

// ---- Overlords + mines (burrowing zone-denial — punishes camping) ----
function plantMineImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    mines: Mine[], targets: SpeciesCtx['targets'], pos: THREE.Vector3, uber = false): void {
  const { scene } = deps;
  const { burrow, blastAtPlayer } = kit;
  // Cap the field: dropping a new mine past the cap retires the oldest
  if (mines.length >= MINE_MAX) {
    const oldest = mines.shift()!;
    oldest.onDetonate = undefined; // retires quietly — no fake explosion
    oldest.dead = true;
    oldest.dispose();
    const ti = targets.indexOf(oldest);
    if (ti >= 0) targets.splice(ti, 1);
  }
  const m = new Mine(scene, deps.lazyTerrain(), pos, uber);
  burrow(m); // planted mines bury themselves — thematic even from an Overlord drop
  const player = deps.lazyPlayer();
  m.onDetonate = (mine) => {
    // Mine pop — compact dirty-orange blast, not a rocket. Doombloom's
    // blastRadius field carries its doubled envelope.
    deps.world.explosions.push(new Explosion(scene, mine.pos, false, 0, deps.lazyTerrain(), mine.blastRadius / ROCKET_RADIUS, 0xff7733));
    sfx.explosionAt(mine.pos, true);
    screenShake.blast(mine.pos, mine.uber ? 4 : 2.5, player.pos);
    blastAtPlayer(mine.pos, mine.blastRadius, MINE_DAMAGE_MAX, MINE_KNOCKBACK,
      mine.uber ? 'flowered by a doombloom' : 'blown up by a mine', mine.uber ? 1.5 : 1);
    if (mine.uber) {
      // Doombloom chain: its blast sets off every OTHER mine it touches —
      // clearing a doombloom field by shooting one is a gamble, not a plan.
      // Each mine's own dead flag means the chain terminates naturally.
      for (const other of mines) {
        if (!other.dead && other !== mine && other.pos.distanceToSquared(mine.pos) < mine.blastRadius * mine.blastRadius) {
          other.takeDamage(); // any damage detonates a mine
        }
      }
    }
  };
  mines.push(m);
  targets.push(m);
}

// Overlord brood: green sac pop — same blast read as a mine, but rolling
function spawnBanelingImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    banelings: Baneling[], targets: SpeciesCtx['targets'], pos: THREE.Vector3, uber = false): void {
  const { scene } = deps;
  const { atCap, blastAtPlayer } = kit;
  if (atCap(banelings, capFor('baneling', BANELING_MAX))) return;
  const b = new Baneling(scene, deps.lazyTerrain(), pos, uber);
  if (b.dead) { b.dispose(); return; }
  const player = deps.lazyPlayer();
  b.onDetonate = (bane) => {
    // blastRadius is per-instance — a goliath pops 1.7× wider
    deps.world.explosions.push(new Explosion(scene, bane.pos, false, 0, deps.lazyTerrain(), bane.blastRadius / ROCKET_RADIUS, 0x77ff44));
    sfx.explosionAt(bane.pos, true);
    screenShake.blast(bane.pos, bane.uber ? 3.5 : 2.0, player.pos);
    if (blastAtPlayer(bane.pos, bane.blastRadius, BANELING_DAMAGE_MAX, BANELING_KNOCKBACK,
      bane.uber ? 'melted by a goliath' : 'melted by a baneling', bane.uber ? 1.4 : 1) > 0) {
      sfx.playerHurt();
    }
  };
  banelings.push(b);
  targets.push(b);
}

// ---- Totems (peak-seeking sniper obelisks) ----
// Uber totem — the elite sniper: predicts your velocity, tags a held
// course. One at a time; the fat gold obelisk + wide death ray IS the tell.
function spawnTotemImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    totems: Totem[], targets: SpeciesCtx['targets'], uber = false): void {
  const { scene } = deps;
  const { ringPos, boltPop, hurtPlayer } = kit;
  if (deps.lazyDemoManager()?.isPlaying) return;
  const cap = uber ? UBER_TOTEM_MAX : capFor('totem', TOTEM_MAX);
  if (totems.filter(t => !t.dead && (!uber || t.uber)).length >= cap) return;
  const player = deps.lazyPlayer();
  const bolt = uber
    ? { scale: 0.6, color: 0xffaa33, popDur: 3.0, force: 14, dmg: UBER_TOTEM_BOLT_DAMAGE, text: 'sniped by the grand totem' }
    : { scale: 0.35, color: 0xff5566, popDur: 2.0, force: 8, dmg: TOTEM_BOLT_DAMAGE, text: 'struck down by a totem' };
  const t = new Totem(scene, deps.lazyTerrain(), ringPos(TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX), uber);
  t.onBoltLand = (pos) => boltPop(pos, bolt.scale, bolt.color, bolt.popDur);
  t.onBoltHit = () => {
    boltPop(player.pos.clone(), bolt.scale, bolt.color, bolt.popDur);
    hurtPlayer(t.pos, bolt.force, bolt.dmg, bolt.text, undefined, t);
  };
  t.onBlink = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'zap'); }; // departure puff at the old spot
  totems.push(t);
  targets.push(t);
}

// Siege family — things that hurt you at range or punish standing still:
// turretters (self-lobbing artillery with shootable shells), totems (peak
// snipers), overlords (mine-dropping zone denial), plus the mine/baneling
// blast registries they feed.
export function createSiegeSpecies({ deps, kit, targets }: SpeciesCtx) {
  const { scene } = deps;
  const {
    removeTarget, ringPos, hurtPlayer, bite, blastAtPlayer,
    aggroFor, aggroVelFor, boltPop, updateSpecies, burrow, rollUber, kickDust, kickTrail, atCap,
  } = kit;

  const turrets: Turretter[] = [];
  const overlords: Overlord[] = [];
  const mines: Mine[] = [];
  const banelings: Baneling[] = [];
  const totems: Totem[] = [];

  const siegeKit: SiegeKit = { burrow, blastAtPlayer, hurtPlayer, boltPop, rollUber, ringPos, atCap, removeTarget };

  // ---- Turretters (plant-and-shell enemies that lob themselves at you) ----
  function spawnTurretter(uber?: boolean): void {
    if (atCap(turrets, capFor('turret', TURRET_MAX))) return;
    const u = uber ?? rollUber();
    const player = deps.lazyPlayer();
    const t = new Turretter(scene, deps.lazyTerrain(), ringPos(TURRET_SPAWN_MIN, TURRET_SPAWN_MAX), u);
    t.onLanded = (pos) => boltPop(pos, 0.4, 0xff8844, 2.4);
    t.onLaunch = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'launch'); };
    t.onBoltLand = (pos) => boltPop(pos, 0.3, 0xffaa44, 1.8);
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.3, 0xffaa44, 1.8);
      bite(t, 6, TURRET_BOLT_DAMAGE, 'shelled by a turretter', { force: 1, dmg: 1.5, text: 'shelled by a siege engine' });
    };
    turrets.push(t);
    targets.push(t);
  }

  const turretSpecies: Species<Turretter> = {
    list: turrets, interval: TURRET_SPAWN_INTERVAL, t: -70,
    spawn: spawnTurretter,
    tick: (t, dt) => t.update(dt, deps.lazyTerrain(), aggroFor(t, t.pos, dt, PROFILES.artillery), aggroVelFor(t)),
  };
  function updateTurrets(dt: number): void { updateSpecies(turretSpecies, dt); }

  // Turretter shells are shootable. `turretBolts` hands combat the live
  // list once per frame for the projectile sweep; `consumeBolt` removes
  // the intercepted one; `cookBoltsNear` chain-detonates bolts caught in
  // a cookoff blast (a mega explosion pops neighboring shells too).
  const _boltList: Bolt[] = [];
  function turretBolts(): Bolt[] {
    _boltList.length = 0;
    for (const t of turrets) {
      if (t.dead) continue;
      for (const b of t.bolts) _boltList.push(b);
    }
    return _boltList;
  }

  function consumeBolt(bolt: Bolt): void {
    for (const t of turrets) {
      const i = t.bolts.indexOf(bolt);
      if (i >= 0) { t.detonateBolt(i); return; }
    }
  }

  const _boltKills: THREE.Vector3[] = [];
  function cookBoltsNear(pos: THREE.Vector3, radius: number): THREE.Vector3[] {
    _boltKills.length = 0;
    const r2 = radius * radius;
    for (const t of turrets) {
      if (t.dead) continue;
      for (let i = t.bolts.length - 1; i >= 0; i--) {
        if (t.bolts[i].pos.distanceToSquared(pos) < r2) {
          _boltKills.push(t.bolts[i].pos.clone());
          t.detonateBolt(i);
        }
      }
    }
    return _boltKills;
  }

  function spawnOverlord(uber?: boolean): void {
    // Also called by director events — the species loop isn't the only caller
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (atCap(overlords, capFor('overlord', OVERLORD_MAX))) return;
    const u = uber ?? rollUber();
    const m = new Overlord(scene, deps.lazyTerrain(), ringPos(OVERLORD_SPAWN_MIN, OVERLORD_SPAWN_MAX), u);
    m.onMineDrop = (overlord) => {
      spawnBaneling(overlord.pos); // drops to the terrain and immediately rolls
      if (overlord.uber) {
        // Broodmother twin drop — a second sac spills out right behind
        spawnBaneling(overlord.pos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4)), rollUber());
      }
      deps.lazyEffects().spawnJumpDust(overlord.pos); // belly puff marks the birth
    };
    overlords.push(m);
    targets.push(m);
  }

  function plantMine(pos: THREE.Vector3, uber = false): void {
    plantMineImpl(deps, siegeKit, mines, targets, pos, uber);
  }
  function spawnBaneling(pos: THREE.Vector3, uber = false): void {
    spawnBanelingImpl(deps, siegeKit, banelings, targets, pos, uber);
  }
  function spawnTotem(uber = false): void {
    spawnTotemImpl(deps, siegeKit, totems, targets, uber);
  }

  const overlordSpecies: Species<Overlord> = {
    list: overlords, interval: OVERLORD_SPAWN_INTERVAL, t: -100,
    spawn: spawnOverlord,
    tick: (m, dt) => { m.update(dt, deps.lazyTerrain(), aggroFor(m, m.pos, dt, PROFILES.siege)); kickTrail(m, dt); },
  };
  function updateOverlords(dt: number): void {
    updateSpecies(overlordSpecies, dt);
    reapSpecies(mines, targets, dt, (m) => m.update(dt, aggroFor(m, m.pos, dt, PROFILES.fodder)));
    reapSpecies(banelings, targets, dt, (b) => { b.update(dt, deps.lazyTerrain(), aggroFor(b, b.pos, dt, PROFILES.hunter)); kickDust(b, dt); });
  }
  function spawnUberTotem(): void { spawnTotem(true); }

  const totemSpecies: Species<Totem> = {
    list: totems, interval: TOTEM_SPAWN_INTERVAL, t: -120,
    spawn: spawnTotem,
    tick: (t, dt) => t.update(dt, deps.lazyTerrain(), aggroFor(t, t.pos, dt, PROFILES.sniper), aggroVelFor(t)),
  };
  function updateTotems(dt: number): void { updateSpecies(totemSpecies, dt); }

  return {
    turrets, overlords, mines, banelings, totems,
    spawnTurretter, spawnOverlord, spawnTotem, spawnUberTotem, plantMine,
    turretBolts, consumeBolt, cookBoltsNear,
    updateTurrets, updateOverlords, updateTotems,
  };
}
