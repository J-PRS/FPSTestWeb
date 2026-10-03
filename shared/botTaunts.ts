// Quake-style kill/death chatter for server bots — rides the real 'chat'
// wire so it lands in the same feed as player lines. Cooldown + a speak
// chance keep it a flavor line, not a spam channel.

import { botRand } from './botRand.ts';
import { sharedNow } from './env.ts';

const KILL_LINES = [
  'wp',
  'ez {v}',
  'ez kill',
  'nice catch {v}',
  'gotcha {v}',
  'sorry',
  're',
  'close one',
  'ty for standing still {v}',
  'lucked out',
  '{v} walked into that',
  'gg {v}',
  'deleted {v}',
  'sent {v} back to spawn',
  'outplayed',
  'read {v} like a book',
  'sit down {v}',
  'that one was free',
  'catch these discs {v}',
  'ski faster {v}',
  'not even close',
  'who taught {v} to ski',
  'refunded {v}',
  'freight train, no brakes',
  'owned {v}',
  'piece of cake',
  'all skill no luck',
  'nothing personal {v}',
  'get good {v}',
  'see you in 5 seconds {v}',
  'ns',
  'midair',
  'air-mailed {v}',
  'lead the target {v}',
  'grounded {v}',
  'down you go {v}',
  'popped',
  'noted',
  'ski school dropout {v}',
  'gg no re {v}',
  'took the scenic route to spawn',
  'caught {v} mid-route',
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
  'bs',
  'lucky {k}',
  'ran out of luck',
  'my ping spiked',
  'that was my warmup death',
  'remind me to dodge next time',
  'decent shot {k}',
  'i let {k} have that one',
  'respawning in style',
  'report {k}',
  'ok {k} is on the list now',
  'shazbot',
  'ns {k}',
  'wd',
  'noted',
  'good read {k}',
  'skied into it',
  'full send',
  'my bad',
  'tilted',
];

const ENV_DEATH_LINES = [
  'who put a wall there',
  'meant to do that',
  'fat fingered',
  'terrain won',
  'missed the jump',
  'the ground came out of nowhere',
  'gravity is cheating',
  'that slope moved',
  'i clipped the air',
  'tactical reset',
  'i died on my own terms',
  'gravity 1 me 0',
  'physics tax',
  'the mountain bites',
  'skied too hard',
  'full send, no landing',
  'shazbot',
];

const SPREE_LINES = [
  'ok that was a run',
  'still alive somehow',
  'whew',
  'they keep lining up',
  'someone call an exterminator',
  'this is fine',
  'ez lobby honestly',
  'i could do this all day',
  'woohoo',
  'route is clear',
  'snowballing',
  'untouchable today',
];

// ---- Situation pools — brains emit event kinds (BrainOut.say), hosts
// resolve them through `chatter()` so the cooldown gate applies to all. ----

/** Fresh target acquired — hunt went null→player enemy this think. */
const CONTACT_LINES = [
  'contact',
  'eyes on {t}',
  'movement',
  'spotted {t}',
  'incoming {t}',
  'there {t} is',
  'target up',
  'found you {t}',
];

/** Hunt dropped — they broke LOS or died before the bot finished. */
const LOST_LINES = [
  'lost them',
  'they slipped',
  'gone',
  'lost visual',
  'where did {t} go',
  'they ran',
];

/** Committed to chasing the beacon-marked flag carrier. */
const THIEF_LINES = [
  'carrier marked',
  'on the carrier',
  'our flag is moving',
  'flag thief',
  'not letting {t} walk',
];

/** Rising edge of fear — below FEAR_HP with no hero roll. */
const FEAR_LINES = [
  'falling back',
  'too hot',
  'breaking off',
  'im hit bad',
  'need a medic',
];

/** Rising edge of a hero roll — low HP, last-stand mode instead. */
const HERO_LINES = [
  'screw it',
  'all in',
  'last stand',
  'no retreat',
  'come get it',
];

/** Inbound shells detected — the dodge sense just fired. */
const UNDERFIRE_LINES = [
  'taking fire',
  'who shot me',
  'im hit',
  'suppressed',
  'shots inbound',
];

/** Belt lob went out this step. */
const BELT_LINES = [
  'frag out',
  'fire in the hole',
  'catch',
  'special delivery',
];

/** Deploy claim went out — a builder's emplacement landed. */
const DEPLOY_LINES = [
  'turret up',
  'deploying',
  'setting up shop',
  'fortifying',
  'hardware inbound',
];

/** Long stretch with nothing seen — the quiet-match murmur. */
const BORED_LINES = [
  'quiet out there',
  'where is everyone',
  'dead lobby',
  'anyone?',
  'crickets',
  'this map is huge',
  'just me and the wind',
];

/** The bot's own flag play — grabbed the enemy flag. */
const FLAG_GRAB_LINES = [
  'flag secured',
  'routing home',
  'got it, moving',
  'snatched',
  'im out',
];

/** The bot capped. */
const FLAG_CAP_LINES = [
  'capped',
  'delivery made',
  'one down',
  'that counts',
  'easy route',
];

/** The bot returned a dropped flag by touch. */
const FLAG_RETURN_LINES = [
  'saved it',
  'flag home',
  'not on my watch',
  'got it back',
];

/** The bot died carrying — the fumbled-flag lament. */
const FLAG_DROP_LINES = [
  'fumbled',
  'dropped it',
  'shit',
  'flag loose',
  'so close',
];

/** A teammate just said something — the low-effort acknowledgment that
 *  turns one bark into a two-bot beat. */
const REPLY_LINES = [
  'lol',
  'lmao',
  'w',
  'real',
  'truer',
  'yeah',
  '+1',
  'fax',
  'fr',
  'seconded',
  'this',
  'true',
];

/** Third death in a row — the tilt is audible now. */
const TILT_LINES = [
  'again??',
  'ok who fed {k}',
  'this bot is rigged',
  'cant win with this team',
  'im being griefed',
  'cool cool cool',
  'report my team',
  'why do i even queue',
  'new mouse who dis',
  'uninstalling',
  'i blame the spawns',
  'bro is in my walls {k}',
];

/** Fist kill — a different flavor of humiliation than a frag. */
const FIST_LINES = [
  'punched out {v}',
  'fisted {v}',
  'hands rated E',
  'talk to the fist {v}',
  'knuckle sandwich {v}',
  'put em up {v}',
  'melee diff',
  'gun? what gun {v}',
];

/** A human typed gg — bots close the loop. */
const GG_LINES = [
  'gg',
  'gg wp',
  'gg all',
  'gg no re',
  'gg — same time tomorrow?',
];

/** A human called it ez — salt is the honest response. */
const SALTY_LINES = [
  'we\'ll see',
  'scoreboard says hi',
  'sure thing {t}',
  'mad?',
  'bold words {t}',
  'clip it',
  'noted {t}',
];

/** Someone said the bot's name — acknowledgment, nothing more. */
const MENTION_LINES = [
  'yo',
  'sup {t}',
  '?',
  'yeah?',
  'that\'s me',
  'who pinged me',
  'present',
];

/** Shooter just fragged the one who fragged them last. */
const REVENGE_LINES = [
  'payback',
  'were even {v}',
  'thats for earlier {v}',
  'told you {v}',
  'collected the debt',
];

/** Shooter ended someone's 3+ streak. */
const STREAK_END_LINES = [
  'streak over',
  'halted {v}',
  'youre welcome everyone',
  'someone had to',
];

/** Room event went our way — teammates murmur approval. */
const CHEER_LINES = [
  'nice',
  'lets go',
  'whew',
  'smooth',
  'good route',
  'clean',
  'we eating',
];

/** The other team scored — the losers' side of the room. */
const GROAN_LINES = [
  'damn',
  'ugh',
  'they capped',
  'not again',
  'tragic',
  'come on',
];

/** Our flag just walked out the door — the defense alarm. */
const ALERT_LINES = [
  'they have our flag',
  'flag is out',
  'someone get the flag',
  'our flag!',
  'grab went unnoticed',
];

export type ChatterKind =
  | 'contact' | 'lost' | 'thief' | 'fear' | 'hero' | 'underfire'
  | 'belt' | 'deploy' | 'bored'
  | 'flaggrab' | 'flagcap' | 'flagreturn' | 'flagdrop'
  | 'cheer' | 'groan' | 'alert' | 'reply'
  | 'tilt' | 'fist' | 'gg' | 'salty' | 'mention'
  | 'revenge' | 'streakend';

const CHATTER_POOLS: Record<ChatterKind, string[]> = {
  contact: CONTACT_LINES,
  lost: LOST_LINES,
  thief: THIEF_LINES,
  fear: FEAR_LINES,
  hero: HERO_LINES,
  underfire: UNDERFIRE_LINES,
  belt: BELT_LINES,
  deploy: DEPLOY_LINES,
  bored: BORED_LINES,
  flaggrab: FLAG_GRAB_LINES,
  flagcap: FLAG_CAP_LINES,
  flagreturn: FLAG_RETURN_LINES,
  flagdrop: FLAG_DROP_LINES,
  cheer: CHEER_LINES,
  groan: GROAN_LINES,
  alert: ALERT_LINES,
  reply: REPLY_LINES,
  tilt: TILT_LINES,
  fist: FIST_LINES,
  gg: GG_LINES,
  salty: SALTY_LINES,
  mention: MENTION_LINES,
  revenge: REVENGE_LINES,
  streakend: STREAK_END_LINES,
};

/** Canon VGS alternates — some kinds have a real quick-chat chord, and
 *  bots speak it ~40% of the time instead of text. The line is the
 *  chord's canonical text (clients print `[VFF] I have the flag!`);
 *  untemplated on purpose — VGS lines don't name names. */
const VGS_FOR: Partial<Record<ChatterKind, [vgs: string, text: string][]>> = {
  contact:    [['VTA', 'Target acquired!'], ['VSE', 'Enemy spotted!']],
  thief:      [['VAC', 'Chase the enemy flag carrier!'], ['VTF', 'Target the flag carrier!']],
  fear:       [['VVH', 'Help!'], ['VWF', 'Fall back!']],
  hero:       [['VGTG', 'I am the greatest!']],
  underfire:  [['VWI', 'Incoming!'], ['VWW', 'Watch it!']],
  belt:       [['VWI', 'Incoming!']],
  deploy:     [['VSTT', "I'm deploying turrets."], ['VSTS', "I'll set up defenses."]],
  flaggrab:   [['VFF', 'I have the flag!']],
  flagcap:    [['VFS', 'Our flag is secure!']],
  flagreturn: [['VFS', 'Our flag is secure!']],
  flagdrop:   [['VGO', 'Ooops!']],
  cheer:      [['VGCA', 'Awesome!'], ['VGCN', 'Nice move!']],
  groan:      [['VGS', 'SHAZBOT!'], ['VGTW', 'When will you learn?']],
  alert:      [['VAC', 'Chase the enemy flag carrier!'], ['VDF', 'Defend our flag!']],
  reply:      [['VGY', 'Yes.'], ['VGH', 'Hi.']],
  fist:       [['VGTT', 'THAT was graceful!']],
  gg:         [['VGCG', 'Good game!']],
  salty:      [['VGTB', 'Is that the best you can do?']],
  mention:    [['VGY', 'Yes.'], ['VGRD', "I don't know."]],
  revenge:    [['VGTA', "Awww, that's too bad!"]],
  streakend:  [['VGTB', 'Is that the best you can do?'], ['VGTT', 'THAT was graceful!']],
};
const VGS_CHANCE = 0.4;

/** Situation line for a brain/host event — same cooldown+chance gate as
 *  kill/death chatter. `other` fills {t}/{v} when the line names a foe.
 *  ~40% of gated kinds come back as a VGS chord + its canonical line.
 *  `team` marks non-Global chords (canon: only VG* is all-chat) so the
 *  host can keep "Defend our flag!" off the enemy feed. Bot VGS picks
 *  avoid VV* entirely — a team-scoped reply would never reach an
 *  enemy who prompted it. */
export function chatter(kind: ChatterKind, botId: string, other?: string): { text: string; vgs?: string; team?: boolean } | null {
  return maybe(botId, () => {
    const vgs = VGS_FOR[kind];
    if (vgs && botRand() < VGS_CHANCE) {
      const [chord, text] = pick(vgs);
      return { text, vgs: chord, team: !chord.startsWith('VG') };
    }
    const line = pickLine(CHATTER_POOLS[kind]);
    return { text: other ? line.replace('{t}', other).replace('{v}', other) : line };
  });
}

/** Chords the personal taunts (kill/death/spree) speak ~45% of the
 *  time — the loudest moments were the ones missing VGS entirely, which
 *  is why bot chat read as Quake, not Tribes. All VG* (global scope);
 *  lines are each chord's canonical text. */
const KILL_VGS: [vgs: string, text: string][] = [
  ['VGTB', 'Is that the best you can do?'],
  ['VGTA', "Awww, that's too bad!"],
  ['VGTT', 'THAT was graceful!'],
  ['VGCN', 'Nice move!'],
];
const DEATH_VGS: [vgs: string, text: string][] = [
  ['VGS', 'SHAZBOT!'],
  ['VGTW', 'When will you learn?'],
  ['VGCN', 'Nice move!'],
  ['VGTB', 'Is that the best you can do?'],
];
const ENV_DEATH_VGS: [vgs: string, text: string][] = [
  ['VGO', 'Ooops!'],
  ['VGS', 'SHAZBOT!'],
  ['VWOO', 'Woohoo!'],
];
const SPREE_VGS: [vgs: string, text: string][] = [
  ['VGTG', 'I am the greatest!'],
  ['VGCA', 'Awesome!'],
  ['VWOO', 'Woohoo!'],
];
const TAUNT_VGS_CHANCE = 0.45;

const SPEAK_CHANCE = 0.55;
const COOLDOWN_MS = 20_000;

const lastSpoke = new Map<string, number>();
const pick = <T>(arr: readonly T[]): T => arr[(botRand() * arr.length) | 0]!;
// Recently-spoken ring — the biggest tell of canned chatter is the same
// line landing twice while it's still in short-term memory. One re-roll
// keeps repeats legal but rare (a dice pick, not a queue).
const recent: string[] = [];
const pickLine = (pool: string[]): string => {
  let line = pick(pool);
  if (pool.length > 1 && recent.includes(line)) line = pick(pool);
  recent.push(line);
  if (recent.length > 12) recent.shift();
  return line;
};

export interface TauntLine { text: string; vgs?: string }

/** Roll text-vs-chord for a personal taunt — returns the feed-ready
 *  {text, vgs} pair. Chord lines are canon text; the feed prints the
 *  [VGS] prefix itself. */
function tauntPick(pool: string[], chords: [vgs: string, text: string][], fill: (line: string) => string): TauntLine {
  if (botRand() < TAUNT_VGS_CHANCE) {
    const [chord, text] = pick(chords);
    return { text, vgs: chord };
  }
  return { text: fill(pickLine(pool)) };
}

/** One taunt line for a kill where `botId` fragged `other`, or null when
 *  the bot stays quiet (cooldown or dice). */
export function killTaunt(botId: string, victim: string): TauntLine | null {
  return maybe(botId, () => tauntPick(KILL_LINES, KILL_VGS, (l) => l.replace('{v}', victim)));
}

/** One taunt line when `botId` was fragged by `other`. */
export function deathTaunt(botId: string, killer: string): TauntLine | null {
  return maybe(botId, () => tauntPick(DEATH_LINES, DEATH_VGS, (l) => l.replace('{k}', killer)));
}

/** One taunt line when `botId` died to nobody (fall, own blast, lava). */
export function envDeathTaunt(botId: string): TauntLine | null {
  return maybe(botId, () => tauntPick(ENV_DEATH_LINES, ENV_DEATH_VGS, (l) => l));
}

/** One boast line when `botId` hits a spree tier. */
export function spreeTaunt(botId: string): TauntLine | null {
  return maybe(botId, () => tauntPick(SPREE_LINES, SPREE_VGS, (l) => l));
}

/** A human chat line → the chatter kind it might trigger, or null.
 *  Patterns stay small and high-confidence on purpose — a false positive
 *  reads as a bot answering nonsense, which is worse than silence. */
export function chatKindFor(text: string): ChatterKind | null {
  const t = text.toLowerCase();
  if (/^gg\b/.test(t) || /\bgg(\s|$)/.test(t)) return 'gg';
  if (/\bez\b/.test(t)) return 'salty';
  // The canonical tribes greeting/curse — answering a shazbot is what
  // makes a lobby feel inhabited. 'reply' keeps it low-key.
  if (/shazbot/.test(t)) return 'reply';
  return null;
}

/** Chatter cooldown is wall-clock by nature (a pause between lines, not a
 *  sim step) — injectable so scenario tests can pin time rather than
 *  flake on real elapsed ms. */
let tauntNow: () => number = sharedNow;
export function setTauntClock(now: () => number): void { tauntNow = now; }

// Line production is lazy: a suppressed event draws no RNG and touches
// no ring — quiet rolls cost nothing and can't starve a replay's seed.
function maybe<T>(botId: string, line: () => T): T | null {
  const now = tauntNow();
  const last = lastSpoke.get(botId) ?? 0;
  if (now - last < COOLDOWN_MS || botRand() > SPEAK_CHANCE) return null;
  lastSpoke.set(botId, now);
  if (lastSpoke.size > 256) lastSpoke.clear();
  return line();
}

/** Test hook — cooldown/repeat state is per-process, tests need a clean table. */
export function resetTauntCooldowns(): void { lastSpoke.clear(); recent.length = 0; }
