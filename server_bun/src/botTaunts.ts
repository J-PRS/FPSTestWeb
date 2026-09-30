// Quake-style kill/death chatter for server bots — rides the real 'chat'
// wire so it lands in the same feed as player lines. Cooldown + a speak
// chance keep it a flavor line, not a spam channel.

const KILL_LINES = [
  '{v} had it coming.',
  'You fight like a dairy farmer, {v}.',
  'Sit down, {v}.',
  '{v} just got schooled.',
  'Is that all you got, {v}?',
  'Fragged like it was nothing.',
  '{v}, meet my spinfusor.',
  'Too slow, {v}.',
  'Another one bites the dust.',
  'I eat {v}s for breakfast.',
];

const DEATH_LINES = [
  'Lucky shot, {k}.',
  'Ouch.',
  'That was my favorite armor!',
  '{k} got me this time.',
  'I demand a rematch.',
  'Totally meant to do that.',
  'LAG. Definitely lag.',
  '{k}, you cheated. Somehow.',
  'Enjoy it while it lasts, {k}.',
  'My shoelace was untied.',
];

const SPEAK_CHANCE = 0.55;
const COOLDOWN_MS = 20_000;

const lastSpoke = new Map<string, number>();
const pick = (arr: string[]): string => arr[(Math.random() * arr.length) | 0]!;

/** One taunt line for a kill where `botId` fragged `other`, or null when
 *  the bot stays quiet (cooldown or dice). */
export function killTaunt(botId: string, victim: string): string | null {
  return maybe(botId, pick(KILL_LINES).replace('{v}', victim));
}

/** One taunt line when `botId` was fragged by `other`. */
export function deathTaunt(botId: string, killer: string): string | null {
  return maybe(botId, pick(DEATH_LINES).replace('{k}', killer));
}

function maybe(botId: string, line: string): string | null {
  const now = Date.now();
  const last = lastSpoke.get(botId) ?? 0;
  if (now - last < COOLDOWN_MS || Math.random() > SPEAK_CHANCE) return null;
  lastSpoke.set(botId, now);
  if (lastSpoke.size > 256) lastSpoke.clear();
  return line;
}

/** Test hook — cooldown state is per-process, tests need a clean table. */
export function resetTauntCooldowns(): void { lastSpoke.clear(); }
