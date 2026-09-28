// Declarative species registry — every instanced species' render spec in
// one table. Adding an enemy = one entry here + its species block, instead
// of touching main.ts/config/gameLoop by hand. Parts come from each entity
// module; capacity is the instanced-mesh ceiling (visible cap, not pop cap).
import type { SwarmSpec } from '../../entities/swarms.js';
import { crawlerParts } from '../../entities/Crawler.js';
import { scarabParts } from '../../entities/Scarab.js';
import { grubParts } from '../../entities/Grub.js';
import { snakeParts } from '../../entities/Snake.js';
import { gnatParts } from '../../entities/Gnat.js';
import { rollerParts } from '../../entities/Roller.js';
import { seekerParts } from '../../entities/Seeker.js';
import { rakkParts } from '../../entities/Rakk.js';
import { striferParts } from '../../entities/Strifer.js';
import { mineParts } from '../../entities/Mine.js';
import { overlordParts } from '../../entities/Overlord.js';
import { banelingParts } from '../../entities/Baneling.js';
import { totemParts } from '../../entities/Totem.js';
import { turretterParts } from '../../entities/Turretter.js';
import { ballParts } from '../../entities/balls.js';
import { weedParts } from '../../entities/Tumbleweed.js';

export const SWARM_SPECS: Record<string, SwarmSpec> = {
  crawler:   { parts: crawlerParts,   capacity: 512 },
  scarab:    { parts: scarabParts,    capacity: 512 },
  grub:      { parts: grubParts,      capacity: 256 },
  snake:     { parts: snakeParts,     capacity: 256 },
  gnat:      { parts: gnatParts,      capacity: 256 },
  roller:    { parts: rollerParts,    capacity: 256 },
  seeker:    { parts: seekerParts,    capacity: 256 },
  rakk:      { parts: rakkParts,      capacity: 256 },
  strifer:   { parts: striferParts,   capacity: 128 },
  mine:      { parts: mineParts,      capacity: 512 },
  overlord:  { parts: overlordParts,  capacity: 64 },
  baneling:  { parts: banelingParts,  capacity: 128 },
  totem:     { parts: totemParts,     capacity: 64 },
  turretter: { parts: turretterParts, capacity: 64 },
  ball:      { parts: ballParts,      capacity: 512 },
  tumbleweed:{ parts: weedParts,      capacity: 64 },
};
