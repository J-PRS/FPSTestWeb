// Quake-style kill/death chatter for server bots — rides the real 'chat'
// wire so it lands in the same feed as player lines. Cooldown + a speak
// chance keep it a flavor line, not a spam channel.

import { botRand } from './botRand.ts';
import { sharedNow } from './env.ts';
import { TREE, type VgsNode } from './vgsTree.ts';

/** chord → canon line, walked out of the shared VGS tree — the same
 *  table the menu and TTS use. Bots store CHORDS, not chord/text pairs,
 *  so a mismatched pairing can't be written here; the wrong-chord pick
 *  is the only remaining error. */
const VGS_LOOKUP = new Map<string, { text: string; team: boolean }>();
(function walk(node: Record<string, VgsNode>, path: string): void {
  for (const [k, n] of Object.entries(node)) {
    const chord = path + k;
    if ('line' in n) VGS_LOOKUP.set('V' + chord, { text: n.line, team: n.team !== false });
    else walk(n.children, chord);
  }
})(TREE, '');
const vgsText = (chord: string): string => VGS_LOOKUP.get(chord)?.text ?? chord;
const vgsTeam = (chord: string): boolean => VGS_LOOKUP.get(chord)?.team ?? true;

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

// ---- Match-end pools — the horn beat: what a bot says depends on how
// its side finished, so the room's chatter reads the scoreboard too. ----

/** Won the match — the celebrate-and-gg mix a winning lobby sounds like. */
const END_WIN_LINES = [
  'gg',
  'gg wp',
  'ggs',
  'ez',
  'good game',
  'wp team',
  'we did it',
  'gg ez',
  'too easy',
  'thats a wrap',
];
/** Lost the match — salt-and-respect mix; losing bots still say gg. */
const END_LOSS_LINES = [
  'gg',
  'gg wp',
  'we had it',
  'close one',
  'shazbot',
  'unlucky',
  'gg anyway',
  'next map is ours',
  'rough one',
  'gg, rematch',
];
/** Margin of 1 — the down-to-the-wire read both sides share. */
const END_CLOSE_LINES = [
  'gg',
  'gg wp',
  'down to the wire',
  'so close',
  'wp both teams',
  'what a finish',
  'heart attack game',
];
/** Tied at the horn — the rare nobody-won lobby. */
const END_DRAW_LINES = [
  'gg all',
  'a tie??',
  'draw game',
  'shazbot of a finish',
  'nobody wins huh',
];

/** Won BY A POINT — winners of a squeaker trash-talk ironically; the
 *  respect lines stay in the mix so it lands as banter, not a script. */
const END_WINCLOSE_LINES = [
  'easiest game of my life',
  'barely broke a sweat',
  'ez',
  'gg (sweating)',
  'almost had to try',
  'down to the wire',
  'what a finish',
  'wp both teams',
];
/** Match start — the gl-hf lobby opener. */
const START_LINES = [
  'gl hf',
  'gl',
  'hf',
  'lets ski',
  'gl all',
  'ski fast die young',
  'game on',
  'gg in advance',
  'warmup over',
  'lets go',
];

export type EndOutcome = 'win' | 'loss' | 'close' | 'winclose' | 'draw';
const END_POOLS: Record<EndOutcome, string[]> = {
  win: END_WIN_LINES,
  loss: END_LOSS_LINES,
  close: END_CLOSE_LINES,
  winclose: END_WINCLOSE_LINES,
  draw: END_DRAW_LINES,
};
const END_VGS: Record<EndOutcome, string[]> = {
  win:   ['VGCG', 'VGW', 'VGCA'],
  loss:  ['VGCG', 'VGS'],
  close: ['VGCG', 'VGCA'],
  winclose: ['VGCG', 'VGCA'],
  draw:  ['VGCG', 'VGS'],
};

/** One match-start line — same once-per-match shape as endTaunt: high
 *  flat participation, no shared cooldown, stamps lastSpoke. */
export function startTaunt(botId: string): TauntLine | null {
  if (botRand() > 0.7) return null;
  lastSpoke.set(botId, tauntNow());
  if (botRand() < 0.35) {
    const chord = pick(['VGH', 'VGH', 'VGW']);
    return { text: vgsText(chord), vgs: chord };
  }
  return { text: pickLine(START_LINES) };
}

/** One match-end line for `botId`, shaped by how its side finished.
 *  NOT the shared cooldown gate — the gg beat is a once-per-match moment
 *  and a bot that just taunted shouldn't sit it out; participation is a
 *  flat high roll of its own. Still stamps lastSpoke so a bot that got
 *  its line doesn't then double-speak through another path. */
export function endTaunt(botId: string, outcome: EndOutcome): TauntLine | null {
  if (botRand() > END_SPEAK_CHANCE) return null;
  lastSpoke.set(botId, tauntNow());
  const chords = END_VGS[outcome];
  if (botRand() < TAUNT_VGS_CHANCE) {
    const chord = pick(chords);
    return { text: vgsText(chord), vgs: chord };
  }
  return { text: pickLine(END_POOLS[outcome]) };
}

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

/** A human is machine-gunning the feed — VGQ is the canon answer but
 *  kept rare upstream so it lands as annoyance, not a reflex. */
const QUIET_LINES = [
  'less typing more skiing {t}',
  'shut it {t}',
  'my ears {t}',
  'we get it {t}',
];

/** You died to a genuinely hard shot — the sportsmanship half of the
 *  personality. `{t}` is the shooter who earned it. */
const PROPS_LINES = [
  'nice shot {t}',
  'sick shot',
  'what a shot',
  'wp {t}',
  'respect',
  'filthy shot {t}',
  'clean',
  'okay that was sick',
];

/** A bot watched someone crater or frag themselves nearby — the
 *  peanut-gallery quip. `{t}` is the victim. */
const WITNESS_LINES = [
  'nice one {t}',
  'smooth',
  '10/10 landing',
  'did the ground hurt {t}',
  'rofl',
  'watch and learn {t}',
  'graceful',
  'clip it {t}',
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
  | 'revenge' | 'streakend' | 'quiet' | 'witness' | 'props';

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
  quiet: QUIET_LINES,
  mention: MENTION_LINES,
  revenge: REVENGE_LINES,
  streakend: STREAK_END_LINES,
  witness: WITNESS_LINES,
  props: PROPS_LINES,
};

/** Canon VGS alternates — some kinds have a real quick-chat chord, and
 *  bots speak it ~40% of the time instead of text. Chords only: the
 *  line text resolves out of the shared tree (vgsText), never written
 *  here — so a pair like VGCS→wrong text can't exist. Chord validity
 *  is on the author; text correctness is the tree's. */
const VGS_FOR: Partial<Record<ChatterKind, string[]>> = {
  contact:    ['VTA', 'VSE'],
  thief:      ['VAC', 'VTF'],
  fear:       ['VVH', 'VWF'],
  hero:       ['VGTG'],
  underfire:  ['VWI', 'VWW'],
  belt:       ['VWI'],
  deploy:     ['VSTT', 'VSTS'],
  flaggrab:   ['VFF'],
  flagcap:    ['VFS'],
  flagreturn: ['VFS'],
  flagdrop:   ['VGO'],
  cheer:      ['VGCA', 'VGCN'],
  groan:      ['VGS', 'VGTW'],
  alert:      ['VAC', 'VDF'],
  reply:      ['VGY', 'VGH'],
  fist:       ['VGTT'],
  gg:         ['VGCG'],
  salty:      ['VGTB'],
  quiet:      ['VGQ', 'VGQ'],
  mention:    ['VGY', 'VGRD'],
  revenge:    ['VGTA'],
  witness:    ['VGCN', 'VGTB'],
  props:      ['VGCS', 'VGCY', 'VGCA', 'VGCN'],
  streakend:  ['VGTB', 'VGTT'],
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
      const chord = pick(vgs);
      return { text: vgsText(chord), vgs: chord, team: vgsTeam(chord) };
    }
    const line = pickLine(CHATTER_POOLS[kind]);
    return { text: other ? line.replace('{t}', other).replace('{v}', other) : line };
  });
}

/** Chords the personal taunts (kill/death/spree) speak ~45% of the
 *  time — the loudest moments were the ones missing VGS entirely, which
 *  is why bot chat read as Quake, not Tribes. All VG* (global scope). */
const KILL_VGS = ['VGTB', 'VGTA', 'VGTT', 'VGCN'];
const DEATH_VGS = ['VGS', 'VGCN', 'VGTB'];
const ENV_DEATH_VGS = ['VGO', 'VGS', 'VGW'];
const SPREE_VGS = ['VGTG', 'VGCA', 'VGW'];
/** Killing the SAME victim again while the last one still stings — the
 *  dominance beat. VGTW is double-listed: it IS the canon line here. */
const REPEAT_KILL_LINES = [
  'again {v}?',
  'you again {v}',
  'learn anything {v}?',
  'same move twice {v}',
  'deja vu {v}',
  'stop feeding {v}',
  'groundhog day {v}',
];
const REPEAT_KILL_VGS = ['VGTW', 'VGTW', 'VGTB'];
const TAUNT_VGS_CHANCE = 0.45;

const SPEAK_CHANCE = 0.55;
const COOLDOWN_MS = 20_000;
// Match-over participation — nearly everyone says something at the horn;
// the stagger (killFeed) is what keeps it from reading as a chorus.
const END_SPEAK_CHANCE = 0.8;
// Set by the match lifecycle (roomMatch.end/startNext): once the horn
// fires, gameplay chatter (kills, contacts, 'incoming') is dead air —
// only the outcome-shaped endTaunt beat should land on the scoreboard.
let matchMuted = false;
export function setMatchMuted(muted: boolean): void { matchMuted = muted; }

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
function tauntPick(pool: string[], chords: string[], fill: (line: string) => string): TauntLine {
  if (botRand() < TAUNT_VGS_CHANCE) {
    const chord = pick(chords);
    return { text: vgsText(chord), vgs: chord };
  }
  return { text: fill(pickLine(pool)) };
}

/** Frag history for the repeat-kill read — kills are recorded whether or
 *  not the bot speaks, so a silent frag still counts toward the pattern. */
const lastKillOn = new Map<string, number>();
const REPEAT_KILL_MS = 90_000;

/** One taunt line for a kill where `botId` fragged `other`, or null when
 *  the bot stays quiet (cooldown or dice). The same victim inside 90s
 *  flips the pool to dominance lines — VGTW lives there, not in deaths. */
export function killTaunt(botId: string, victim: string): TauntLine | null {
  const key = `${botId}|${victim}`;
  const repeat = tauntNow() - (lastKillOn.get(key) ?? Number.NEGATIVE_INFINITY) < REPEAT_KILL_MS;
  lastKillOn.set(key, tauntNow());
  if (lastKillOn.size > 256) lastKillOn.clear();
  return maybe(botId, () => repeat
    ? tauntPick(REPEAT_KILL_LINES, REPEAT_KILL_VGS, (l) => l.replace('{v}', victim))
    : tauntPick(KILL_LINES, KILL_VGS, (l) => l.replace('{v}', victim)));
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
  if (matchMuted) return null;
  const now = tauntNow();
  const last = lastSpoke.get(botId) ?? 0;
  if (now - last < COOLDOWN_MS || botRand() > SPEAK_CHANCE) return null;
  lastSpoke.set(botId, now);
  if (lastSpoke.size > 256) lastSpoke.clear();
  return line();
}

/** Test hook — cooldown/repeat state is per-process, tests need a clean table. */
export function resetTauntCooldowns(): void {
  lastSpoke.clear();
  lastKillOn.clear();
  recent.length = 0;
  matchMuted = false;
}
