// Quake-style kill/death chatter for server bots — rides the real 'chat'
// wire so it lands in the same feed as player lines. Cooldown + a speak
// chance keep it a flavor line, not a spam channel.

import { botRand, botRng } from './botRand.ts';

const KILL_LINES = [
  'wp',
  'nice catch {v}',
  'gotcha {v}',
  'sorry',
  're',
  'close one',
  'ty for standing still {v}',
  'lucked out',
  '{v} walked into that',
  'gg {v}',
];

const DEATH_LINES = [
  'wp {k}',
  'nice',
  'gg',
  'lag',
  'fair',
  'ow',
  'again {k}',
  'deserved',
  'walked into that',
  'yep',
];

const ENV_DEATH_LINES = [
  'who put a wall there',
  'meant to do that',
  'fat fingered',
  'terrain won',
  'missed the jump',
];

const SPREE_LINES = [
  'ok that was a run',
  'still alive somehow',
  'whew',
];

const SPEAK_CHANCE = 0.55;
const COOLDOWN_MS = 20_000;

const lastSpoke = new Map<string, number>();
// Kept as an alias — callers seed once via botRng and taunts follow.
export function tauntRng(r: () => number): void { botRng(r); }
const pick = (arr: string[]): string => arr[(botRand() * arr.length) | 0]!;

/** One taunt line for a kill where `botId` fragged `other`, or null when
 *  the bot stays quiet (cooldown or dice). */
export function killTaunt(botId: string, victim: string): string | null {
  return maybe(botId, pick(KILL_LINES).replace('{v}', victim));
}

/** One taunt line when `botId` was fragged by `other`. */
export function deathTaunt(botId: string, killer: string): string | null {
  return maybe(botId, pick(DEATH_LINES).replace('{k}', killer));
}

/** One taunt line when `botId` died to nobody (fall, own blast, lava). */
export function envDeathTaunt(botId: string): string | null {
  return maybe(botId, pick(ENV_DEATH_LINES));
}

/** One boast line when `botId` hits a spree tier. */
export function spreeTaunt(botId: string): string | null {
  return maybe(botId, pick(SPREE_LINES));
}

function maybe(botId: string, line: string): string | null {
  const now = Date.now();
  const last = lastSpoke.get(botId) ?? 0;
  if (now - last < COOLDOWN_MS || botRand() > SPEAK_CHANCE) return null;
  lastSpoke.set(botId, now);
  if (lastSpoke.size > 256) lastSpoke.clear();
  return line;
}

/** Test hook — cooldown state is per-process, tests need a clean table. */
export function resetTauntCooldowns(): void { lastSpoke.clear(); }
