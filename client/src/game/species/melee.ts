import * as THREE from 'three';

import {
  CRAWLER_MAX, CRAWLER_SPAWN_INTERVAL, CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX, CRAWLER_POUNCE_DAMAGE,
  SCARAB_MAX, SCARAB_SPAWN_INTERVAL, SCARAB_SPAWN_MIN, SCARAB_SPAWN_MAX,
  SCARAB_PACK_MIN, SCARAB_PACK_MAX, SCARAB_BITE_DAMAGE, SCARAB_BITE_FORCE, SCARAB_BITE_DIST,
  GRUB_MAX, GRUB_SPAWN_INTERVAL, GRUB_SPAWN_MIN, GRUB_SPAWN_MAX,
  GRUB_BITE_DAMAGE, GRUB_BITE_FORCE, GRUB_BITE_DIST,
  SNAKE_MAX, SNAKE_SPAWN_INTERVAL, SNAKE_SPAWN_MIN, SNAKE_SPAWN_MAX,
  SNAKE_BITE_DAMAGE, SNAKE_BITE_FORCE, SNAKE_BITE_DIST,
  ROLLER_MAX, ROLLER_SPAWN_INTERVAL, ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX,
  ROLLER_HIT_DAMAGE, ROLLER_HIT_FORCE,
} from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import type { Species } from '../speciesKit.js';
import { PROFILES } from '../targeting.js';
import { Crawler } from '../../entities/Crawler.js';
import { Scarab } from '../../entities/Scarab.js';
import { Grub } from '../../entities/Grub.js';
import { Snake } from '../../entities/Snake.js';
import { Roller } from '../../entities/Roller.js';
import type { SpeciesCtx } from './context.js';
import { capFor } from './ambientCaps.js';

// Ground hunters — the melee family. Crawler/scarab/grub/snake all wire the
// same funnel: spawn ring → burrow entrance → bite callback → hurtPlayer.
export function createMeleeSpecies({ deps, kit, targets }: SpeciesCtx) {
  const { scene } = deps;
  const { burrow, rollUber, ringPos, bite, aggroFor, kickDust, updateSpecies, atCap } = kit;

  const crawlers: Crawler[] = [];
  const scarabs: Scarab[] = [];
  const grubs: Grub[] = [];
  const snakes: Snake[] = [];
  const rollers: Roller[] = [];

  // ---- Crawlers (terrain-hugging targets that pounce) ----
  function spawnCrawler(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && atCap(crawlers, capFor('crawler', CRAWLER_MAX))) return; // events bypass the cap
    const u = uber ?? (!pos && rollUber());
    const c = new Crawler(scene, deps.lazyTerrain(), pos ?? ringPos(CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX), u);
    c.onLanded = (p) => { deps.lazyEffects().spawnJumpDust(p); sfx.enemyCue(p, 'skitter'); };
    c.onPounceHit = (cr) => bite(cr, 10, CRAWLER_POUNCE_DAMAGE, 'devoured by a crawler', { text: 'devoured by the matriarch' }, 3);
    c.onBrood = (cr) => {
      // Matriarch births a scarab — cap-checked, positioned just off her hip
      if (atCap(scarabs, capFor('scarab', SCARAB_MAX))) return;
      const s = new Scarab(scene, deps.lazyTerrain(), cr.pos.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)));
      s.onBite = (sc) => bite(sc, SCARAB_BITE_FORCE, SCARAB_BITE_DAMAGE, 'swarmed by scarabs', undefined, SCARAB_BITE_DIST + 1);
      s.onLanded = (p) => deps.lazyEffects().spawnJumpDust(p);
      scarabs.push(s);
      targets.push(s);
      deps.lazyEffects().spawnJumpDust(cr.pos);
    };
    if (!pos) burrow(c); // event/demo spawns pass an explicit pos — those appear, not burrow
    crawlers.push(c);
    targets.push(c);
  }

  const crawlerSpecies: Species<Crawler> = {
    // Negative t = first-spawn delay — the run breathes in before pressure
    list: crawlers, interval: CRAWLER_SPAWN_INTERVAL, t: -18,
    spawn: spawnCrawler,
    tick: (c, dt) => { c.update(dt, deps.lazyTerrain(), aggroFor(c, c.pos, dt, PROFILES.hunter)); kickDust(c, dt); },
  };
  function updateCrawlers(dt: number): void { updateSpecies(crawlerSpecies, dt); }

  // ---- Scarabs (pack fodder — mow them down in clumps) ----
  function spawnScarab(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && atCap(scarabs, capFor('scarab', SCARAB_MAX))) return;
    const u = uber ?? (!pos && rollUber());
    // One spawn attempt = a whole pack, clustered on the same burrow spot.
    // An uber roll drops ONE dreadbeetle instead — a pack of those is a raid boss.
    const base = pos ?? ringPos(SCARAB_SPAWN_MIN, SCARAB_SPAWN_MAX);
    const n = u ? 1 : pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));
    for (let k = 0; k < n; k++) {
      if (atCap(scarabs, capFor('scarab', SCARAB_MAX))) break;
      const s = new Scarab(scene, deps.lazyTerrain(), base.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), u);
      s.onBite = (sc) => bite(sc, SCARAB_BITE_FORCE, SCARAB_BITE_DAMAGE, 'swarmed by scarabs', { force: 2.5, dmg: 3, text: 'trampled by a dreadbeetle' }, SCARAB_BITE_DIST + 1);
      s.onLanded = (p) => deps.lazyEffects().spawnJumpDust(p);
      if (!pos) burrow(s);
      scarabs.push(s);
      targets.push(s);
    }
  }

  const scarabSpecies: Species<Scarab> = {
    list: scarabs, interval: SCARAB_SPAWN_INTERVAL, t: -8, // fodder arrives early — it's the tutorial swarm
    spawn: spawnScarab,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.hunter)); kickDust(s, dt); },
  };
  function updateScarabs(dt: number): void { updateSpecies(scarabSpecies, dt); }

  // ---- Grubs (walking piñatas — slow, fat, poppable) ----
  function spawnGrub(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && atCap(grubs, capFor('grub', GRUB_MAX))) return;
    const u = uber ?? (!pos && rollUber());
    const g = new Grub(scene, deps.lazyTerrain(), pos ?? ringPos(GRUB_SPAWN_MIN, GRUB_SPAWN_MAX), u);
    g.onBite = (gr) => bite(gr, GRUB_BITE_FORCE, GRUB_BITE_DAMAGE, 'gummed to death by a grub', { text: 'crushed by a bloatgrub' }, GRUB_BITE_DIST + 1);
    if (u) g.onDeath = (mother) => {
      // Bloatgrub births on pop: three live grubs spill out of the corpse —
      // cap-checked so a bloatgrub chain can't flood the field.
      for (let k = 0; k < 3 && !atCap(grubs, capFor('grub', GRUB_MAX)); k++) {
        const child = new Grub(scene, deps.lazyTerrain(), mother.pos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)));
        child.onBite = g.onBite; // same wiring — children are normal grubs
        grubs.push(child);
        targets.push(child);
      }
      deps.lazyEffects().spawnJumpDust(mother.pos);
    };
    if (!pos) burrow(g);
    grubs.push(g);
    targets.push(g);
  }

  const grubSpecies: Species<Grub> = {
    list: grubs, interval: GRUB_SPAWN_INTERVAL, t: -5,
    spawn: spawnGrub,
    tick: (g, dt) => { g.update(dt, deps.lazyTerrain(), aggroFor(g, g.pos, dt, PROFILES.fodder)); kickDust(g, dt); },
  };
  function updateGrubs(dt: number): void { updateSpecies(grubSpecies, dt); }

  // ---- Snakes (sand vipers — weave in, coil, lunge) ----
  function spawnSnake(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && atCap(snakes, capFor('snake', SNAKE_MAX))) return;
    const u = uber ?? (!pos && rollUber());
    const s = new Snake(scene, deps.lazyTerrain(), pos ?? ringPos(SNAKE_SPAWN_MIN, SNAKE_SPAWN_MAX), u);
    s.onStrike = (sn) => bite(sn, SNAKE_BITE_FORCE, SNAKE_BITE_DAMAGE, 'bitten by a sand viper', { dmg: 2.5, text: 'swallowed by the king serpent' }, SNAKE_BITE_DIST + 1);
    if (!pos) burrow(s);
    snakes.push(s);
    targets.push(s);
  }

  const snakeSpecies: Species<Snake> = {
    list: snakes, interval: SNAKE_SPAWN_INTERVAL, t: -30,
    spawn: spawnSnake,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.hunter)); kickDust(s, dt); },
  };
  function updateSnakes(dt: number): void { updateSpecies(snakeSpecies, dt); }

  // ---- Rollers (big homing boulders — the hitbox is the threat) ----
  function spawnRoller(uber?: boolean): void {
    if (atCap(rollers, capFor('roller', ROLLER_MAX))) return;
    const u = uber ?? rollUber();
    const r = new Roller(scene, deps.lazyTerrain(), ringPos(ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX), u);
    r.onLanded = (pos) => deps.lazyEffects().spawnJumpDust(pos);
    r.onHit = (rl) => bite(rl, ROLLER_HIT_FORCE, ROLLER_HIT_DAMAGE, 'steamrolled by a boulder', { force: 1.5, text: 'buried by an avalanche' }, 1.5);
    burrow(r);
    rollers.push(r);
    targets.push(r);
  }

  const rollerSpecies: Species<Roller> = {
    list: rollers, interval: ROLLER_SPAWN_INTERVAL, t: -55,
    spawn: spawnRoller,
    tick: (r, dt) => { r.update(dt, deps.lazyTerrain(), aggroFor(r, r.pos, dt, PROFILES.rammer)); kickDust(r, dt); },
  };
  function updateRollers(dt: number): void { updateSpecies(rollerSpecies, dt); }

  return {
    crawlers, scarabs, grubs, snakes, rollers,
    spawnCrawler, spawnScarab, spawnGrub, spawnSnake, spawnRoller,
    updateCrawlers, updateScarabs, updateGrubs, updateSnakes, updateRollers,
  };
}
