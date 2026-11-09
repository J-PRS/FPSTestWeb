// Declarative species registry - every instanced species' render spec in
// one table. Adding an enemy = one entry here + its species block, instead
// of touching main.ts/config/gameLoop by hand. Parts come from each entity
// module; capacity is the instanced-mesh ceiling (visible cap, not pop cap).
// `spawn` feeds the gunlab's creature preview - omit it when the entity
// doesn't fit the shared (scene, terrain, pos) constructor (Ball takes a
// variant, deployables take ttls).
import type { SwarmSpec } from '../../entities/swarms.js';
import { Crawler, crawlerParts } from '../../entities/Crawler.js';
import { Scarab, scarabParts } from '../../entities/Scarab.js';
import { Grub, grubParts } from '../../entities/Grub.js';
import { Snake, snakeParts } from '../../entities/Snake.js';
import { Gnat, gnatParts } from '../../entities/Gnat.js';
import { Roller, rollerParts } from '../../entities/Roller.js';
import { Seeker, seekerParts } from '../../entities/Seeker.js';
import { Rakk, rakkParts } from '../../entities/Rakk.js';
import { Strifer, striferParts } from '../../entities/Strifer.js';
import { Mine, mineParts } from '../../entities/Mine.js';
import { Overlord, overlordParts } from '../../entities/Overlord.js';
import { Baneling, banelingParts } from '../../entities/Baneling.js';
import { Totem, totemParts } from '../../entities/Totem.js';
import { Buzzard, buzzardParts } from '../../entities/Buzzard.js';
import { Turretter, turretterParts } from '../../entities/Turretter.js';
import { ballParts } from '../../entities/balls.js';
import { Tumbleweed, weedParts } from '../../entities/Tumbleweed.js';

export const SWARM_SPECS: Record<string, SwarmSpec> = {
  crawler:   { parts: crawlerParts,   capacity: 512, max: 6, spawn: (s, t, p): Crawler => new Crawler(s, t, p) },
  scarab:    { parts: scarabParts,    capacity: 512, max: 16, spawn: (s, t, p): Scarab => new Scarab(s, t, p) },
  grub:      { parts: grubParts,      capacity: 256, max: 10, spawn: (s, t, p): Grub => new Grub(s, t, p) },
  snake:     { parts: snakeParts,     capacity: 256, max: 8, spawn: (s, t, p): Snake => new Snake(s, t, p) },
  gnat:      { parts: gnatParts,      capacity: 256, max: 16, spawn: (s, t, p): Gnat => new Gnat(s, t, p) },
  roller:    { parts: rollerParts,    capacity: 256, max: 4, spawn: (s, t, p): Roller => new Roller(s, t, p) },
  seeker:    { parts: seekerParts,    capacity: 256, max: 4, spawn: (s, t, p): Seeker => new Seeker(s, t, p) },
  rakk:      { parts: rakkParts,      capacity: 256, max: 3, spawn: (s, t, p): Rakk => new Rakk(s, t, p) },
  strifer:   { parts: striferParts,   capacity: 128, max: 3, spawn: (s, t, p): Strifer => new Strifer(s, t, p) },
  mine:      { parts: mineParts,      capacity: 512, max: 10, bake: true, // steel shell - gunmetal bake like the turretter
               spawn: (s, t, p) => { // update(dt, playerPos) - no terrain arg, adapt it
                 const m = new Mine(s, t, p);
                 return { pos: m.pos, radius: m.radius,
                   update: (dt, _t, pp): void => m.update(dt, pp), dispose: (): void => m.dispose() };
               } },
  overlord:  { parts: overlordParts,  capacity: 64, max: 2,  spawn: (s, t, p): Overlord => new Overlord(s, t, p) },
  baneling:  { parts: banelingParts,  capacity: 128, max: 12, spawn: (s, t, p): Baneling => new Baneling(s, t, p) },
  totem:     { parts: totemParts,     capacity: 64, max: 2,  spawn: (s, t, p): Totem => new Totem(s, t, p) },
  buzzard:   { parts: buzzardParts,   capacity: 64, max: 6,  spawn: (s, t, p): Buzzard => new Buzzard(s, t, p) },
  turretter: { parts: turretterParts, capacity: 64, bake: true, // gunmetal - same pipeline as viewmodel weapons
               spawn: (s, t, p): Turretter => new Turretter(s, t, p) },
  ball:      { parts: ballParts,      capacity: 512 },
  tumbleweed:{ parts: weedParts,      capacity: 64, max: 10,  spawn: (s, t, p): Tumbleweed => new Tumbleweed(s, t, p) },
};
