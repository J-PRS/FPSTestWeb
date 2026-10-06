// Quake-style kill/death chatter for server bots — rides the real 'chat'
// wire so it lands in the same feed as player lines. Cooldown + a speak
// chance keep it a flavor line, not a spam channel.

import { tauntRand } from './botRand.ts';
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
    if ('line' in n) {VGS_LOOKUP.set(`V${chord}`, { text: n.line, team: n.team !== false });}
    else {walk(n.children, chord);}
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
  // Era deep cuts — Quake lobby-speak, Tribes jargon, forum culture
  'LPB diff',              // low-ping-bastard — canonical Quake insult
  'disc\'d {v}',
  'gibbed {v}',
  'blue plate special {v}',// the spinfusor disc's actual community name
  'ski or die {v}',
  'schooled {v}',
  'served {v}',
  'pwnd',
  'llama {v}',             // slow-cap insult — THE Tribes word
  'camp harder {v}',
  'MA\'d {v}',               // mid-air callout — the crown jewel frag
  'BB\'d {v}',               // body block
  'rolled {v}',
  'chaser down',              // the carrier-hunter role, humbled
  'TM cleared',               // turret monkey / farmer down
  'farmer got farmed',
  'ski free {v}',             // SkiFree — same Windows era, same snow
  'see you at the stand {v}',
  'spammed {v} from beyond LOS', // mortar spam — T2's dirtiest word
  'KS? earned',               // kill-steal accusation, refused
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
  // Era deep cuts — accusations every 90s/00s lobby ran on
  'hax',
  'aimbot much {k}',
  'wallhack {k}',
  'interp got me',
  'warped into it',
  'host advantage',
  'pb pls',                // PunkBuster false-kick folklore
  'zounds',                // Thresh-era Quake
  'LPB wins again',
  'camper got me',
  'spawn roulette',
  'MAMD?? {k} showoff',       // mid-air mine-disc — the unicorn shot
  'played it like a llama',
  'HOF\'d into it',          // ran face-first into Heavy on Flag
  'sick route {k}',           // capper compliment even in death
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
  'SkiFree\'d into the yeti', // same Windows CD, same snow physics
  'failed the DJ',            // disc-jump — speed at the cost of hull
  'terrain TK',
  'disc-jumped into orbit',
  'crater diff',
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
  // UT announcer canon — the spree ladder as self-report
  'rampage',
  'dominating',
  'unstoppable',
  'godlike',
  'm-m-monster kill',
  'wicked sick',
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
  'e-grab!',          // high-speed touch-and-go — T2 vernacular
  'grab and gone',
  'no llama today',   // the slow-cap insult, worn proudly
  'scooped',
  'sanic\'d in',             // Ascend-era speed meme, era-adjacent
  'going home',
];

/** The bot capped. */
const FLAG_CAP_LINES = [
  'capped',
  'delivery made',
  'one down',
  'that counts',
  'easy route',
  'CO watch',                 // cap-out/shutout — the stomp callout
  'shutout brewing',
  'cap out',
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
  'llama\'d it',
  'route diff',      // their route beat my route — capper honesty
  'HOF\'d',
  'inb4 return',
];

/** A teammate just said something — the low-effort acknowledgment that
 *  turns one bark into a two-bot beat. Era mix is deliberate: ~80%
 *  90s/00s (Quake/UT/CS-lobby + forum-speak), ~15% 10s, ~5% 20s — the
 *  chat should sound like the server time-traveled from 2002, with a
 *  couple of stragglers who never left Discord. */
const REPLY_LINES = [
  // 90s/00s — IRC, GameSpy, clan servers, forum culture
  'lol',
  'rofl',
  'heh',
  'hehe',
  'word',
  'kk',
  'yup',
  'n1',
  'owned',
  'qft',          // "quoted for truth" — peak 00s forum
  'teh truth',    // deliberate 'teh' — same typo family as pwned
  'no u',
  'u2',
  'ditto',
  'yea',
  'damn right',
  // 10s — the "this." forum-to-Twitter bridge
  'this',
  'same',
  'truth',
  // 20s — one Discord-native straggler keeps it honest
  'real',
  // Forum-board culture — the reply is the point
  'seconded',
  'sauce?',
  'thread delivers',
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
  'uninstalling',
  'i blame the spawns',
  'fkn hitreg',
  'warp city over here',
  'ff',                        // CS forfeit — the vote of surrender
  'voteban me pls',
  'votekick {k}',          // era lobby democracy
  'team diff',
  'stacked server',
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

const SPEAK_CHANCE = 0.55;
const COOLDOWN_MS = 20_000;
// Match-over participation — nearly everyone says something at the horn;
// the stagger (killFeed) is what keeps it from reading as a chorus.
const END_SPEAK_CHANCE = 0.8;
const TAUNT_VGS_CHANCE = 0.45;
// Set by the match lifecycle (roomMatch.end/startNext): once the horn
// fires, gameplay chatter (kills, contacts, 'incoming') is dead air —
// only the outcome-shaped endTaunt beat should land on the scoreboard.
let matchMuted = false;
export function setMatchMuted(muted: boolean): void { matchMuted = muted; }

const lastSpoke = new Map<string, number>();
const pick = <T>(arr: readonly T[]): T => arr[Math.trunc(tauntRand() * arr.length)] as T;
// Recently-spoken ring — the biggest tell of canned chatter is the same
// line landing twice while it's still in short-term memory. One re-roll
// keeps repeats legal but rare (a dice pick, not a queue).
const recent: string[] = [];
const pickLine = (pool: string[]): string => {
  let line = pick(pool);
  if (pool.length > 1 && recent.includes(line)) {line = pick(pool);}
  recent.push(line);
  if (recent.length > 12) {recent.shift();}
  return line;
};

/** Chatter cooldown is wall-clock by nature (a pause between lines, not a
 *  sim step) — injectable so scenario tests can pin time rather than
 *  flake on real elapsed ms. */
let tauntNow: () => number = sharedNow;
export function setTauntClock(now: () => number): void { tauntNow = now; }

// Line production is lazy: a suppressed event draws no RNG and touches
// no ring — quiet rolls cost nothing and can't starve a replay's seed.
function maybe<T>(botId: string, line: () => T): T | null {
  if (matchMuted) {return null;}
  const now = tauntNow();
  const last = lastSpoke.get(botId) ?? 0;
  if (now - last < COOLDOWN_MS || tauntRand() > SPEAK_CHANCE) {return null;}
  lastSpoke.set(botId, now);
  if (lastSpoke.size > 256) {lastSpoke.clear();}
  return line();
}

/** One match-start line — same once-per-match shape as endTaunt: high
 *  flat participation, no shared cooldown, stamps lastSpoke. */
export function startTaunt(botId: string): TauntLine | null {
  if (tauntRand() > 0.7) {return null;}
  lastSpoke.set(botId, tauntNow());
  if (tauntRand() < 0.35) {
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
  if (tauntRand() > END_SPEAK_CHANCE) {return null;}
  lastSpoke.set(botId, tauntNow());
  const chords = END_VGS[outcome];
  if (tauntRand() < TAUNT_VGS_CHANCE) {
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
  'lawn dart',
  'cratered',
  'terrain diff',
  'SkiFree\'d',
  'DJ\'d into the void',
  'crater season',
];

/** A human opened with a greeting — the lobby acknowledgment, brief and
 *  human. Nobody writes a paragraph back to a 'hi'. */
const HELLO_LINES = [
  'yo',
  'o7',
  'hey',
  'sup',
  'heya',
  'yo {t}',
  'evening',
];

/** A human thanked the room or someone in it — the social contract
 *  answer. {t} is whoever spoke. */
const THANKS_LINES = [
  'np',
  'anytime',
  'got you {t}',
  'np {t}',
  'all good',
  'you earned it',
];

/** A human apologized — shrug it off, everybody whiffs. */
const SORRY_LINES = [
  'all good',
  'happens',
  'np',
  'we have all been there',
  'shake it off',
  'dont sweat it',
];

/** Earnest warmth about the game/map/lobby — the wholesome half of FPS
 *  culture. Bots agree rather than stand there like furniture. */
const WHOLESOME_LINES = [
  'right?',
  'its a good one',
  'same honestly',
  'been saying it all day',
  'genuinely fun lobby',
  'agreed',
  'this server rox',
  'phat map',
  'the ASE was worth the wait', // the All-Seeing Eye — era's real server browser
  'this is why i still play',
  'tribes never dies',
  'found it on a PC Gamer demo disc',
  'still runs on the toaster',
  'this lobby is why i own a 56k upgrade',
];

/** A human is malding in public — the pile-on is the culture, but
 *  sympathy sneaks in occasionally so it reads like a person, not a
 *  heckler subroutine. */
const MALD_LINES = [
  'lol',
  'drama',
  'qq',                    // crying eyes — Quake/WC2 vintage
  'qq more',
  'cry moar',              // 'moar' is 00s forum orthography
  'u mad?',
  'take it to IRC',
  'tell us how you really feel',
  'deep breaths',
  'we have all been there {t}',
  'its just a game',
  'someone call the waaahmbulance', // peak-00s forum slang
  'drama llama',
  'alt+f4 fixes that',
  'log off {t}',
];

/** A human asked the room a question — helpful where confident,
 *  honest shrug where not. Generic tips only: answering with wrong
 *  specifics is worse than a shrug. */
const QUESTION_LINES = [
  'ski downhill, jet uphill',
  'fall with style',
  'good question honestly',
  'ask {t}, they know stuff',
  'ski fast, shoot straight',
  'try things till it works',
  'aim where they land not where they are',
  'the disc is a blue plate — order accordingly',
  'press V like its 1999',
  'check your cl_updaterate',  // CS 1.6 console folklore
  'rtfm',
  'read the MOTD',
];

/** A human is complaining about lag/ping — commiseration is the
 *  universal multiplayer bonding ritual. */
const LAG_LINES = [
  'same boat',
  'the net giveth',
  'its not you its the wires',
  'packet loss is a personality',
  'playing on a toaster too',
  'relatable',
  'HPB life',                  // high-ping-bastard — Quake's canonical gripe
  'welcome to warp city',
  'choke 99%',
  'check your rate settings',
  'interp doing interp things',
  'WON auth is down again',    // Half-Life's auth server — deep cut
  'my 56k is showing',
  'net_graph 3 says it all',   // CS's built-in lagometer
  'rate 25000 my ass',
  'ex_interp 0.01 cope',
];

/** A human announced they are leaving — the valediction. Short, no
 *  guilt trip, occasionally fond. */
const BYE_LINES = [
  'cya',
  'o7',
  'later {t}',
  'gg, take care',
  'well be here',
  'safe travels',
];

/** A teammate called a command over VGS — the squad acknowledgment.
 *  Short radio voice; the canon task-report chords carry it too. */
const ACK_LINES = [
  'on it',
  'roger',
  'copy',
  'got you',
  'covering',
  'wilco',
  'yes sir',
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
  'flag thief inbound',
  'chaser needed',   // the role that hunts carriers
  'they ran a route on us',
];

export type ChatterKind =
  | 'contact' | 'lost' | 'thief' | 'fear' | 'hero' | 'underfire'
  | 'belt' | 'deploy' | 'bored'
  | 'flaggrab' | 'flagcap' | 'flagreturn' | 'flagdrop'
  | 'cheer' | 'groan' | 'alert' | 'reply'
  | 'tilt' | 'fist' | 'gg' | 'salty' | 'mention'
  | 'revenge' | 'streakend' | 'quiet' | 'witness' | 'props'
  | 'hello' | 'thanks' | 'sorry' | 'wholesome' | 'mald'
  | 'question' | 'lag' | 'bye' | 'ack';

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
  hello: HELLO_LINES,
  thanks: THANKS_LINES,
  sorry: SORRY_LINES,
  wholesome: WHOLESOME_LINES,
  mald: MALD_LINES,
  question: QUESTION_LINES,
  lag: LAG_LINES,
  bye: BYE_LINES,
  ack: ACK_LINES,
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
  quiet:      ['VGQ', 'VGQ', 'VGN'],
  mention:    ['VGY', 'VGRD'],
  revenge:    ['VGTA'],
  witness:    ['VGCN', 'VGTB'],
  props:      ['VGCS', 'VGCY', 'VGCA', 'VGCN'],
  streakend:  ['VGTB', 'VGTT'],
  hello:      ['VGH'],
  thanks:     ['VGRA'],
  sorry:      ['VGRA'],
  wholesome:  ['VGCA', 'VGCY', 'VGW'],
  mald:       ['VGTA', 'VGTW'],
  question:   ['VGRD'],
  lag:        ['VGO'],
  bye:        ['VGB'],
  ack:        ['VSTC', 'VSTO'],
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
    if (vgs && tauntRand() < VGS_CHANCE) {
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
const KILL_VGS = ['VGTB', 'VGTA', 'VGTT', 'VGTG', 'VGCN'];
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

export interface TauntLine { text: string; vgs?: string }

/** The "VGS combo" era hack — a second chord fired fast enough to hard-
 *  stop the speaker's in-flight sample ("I am the— SHAZBOT!"). Not a
 *  real feature back then either: players discovered a fresh VGS cuts
 *  their own last sample, so the splice lives in the audio channel,
 *  never the data. Here it's modeled as intent: after speaking a
 *  combo-able chord the bot rolls a rare chance to fire the cut chord
 *  a beat later — two ordinary chat lines, the medium does the splice. */
/** Chord → candidate cut chords (weighted by repetition). Provenance:
 *  VGTG→VGS is the documented flagship ("I am the Shazbot" is a named
 *  meme), VGS→VGS machine-gunning is verbatim spam-era behavior, and the
 *  any-line-into-any-line mechanism is proven by the GO SHAZBOT remix
 *  genre. The rest are era-plausible reconstructions built from canon
 *  lines — the contradiction, the self-hype, the stutter, the sore-
 *  loser hijack — not individually cited pairings. */
const VGS_COMBOS: Readonly<Record<string, readonly string[]>> = {
  VGTG: ['VGS', 'VGS', 'VGY'],  // "I am the— SHAZBOT!" / "I am the— YES." boast undercut
  VGTA: ['VGS', 'VGS', 'VGN', 'VGW'],   // "Awww that's too— SHAZBOT!" / "— NO." / "— WOOHOO!"
  VGTB: ['VGS', 'VGS', 'VGY', 'VGTW'],  // "Is that the best— YES." / "— WHEN WILL YOU LEARN?"
  VGTW: ['VGS', 'VGTW'],        // "When will you— SHAZBOT!" / stutter-repeat
  VGTT: ['VGS', 'VGCN'],                // "THAT was— SHAZBOT!" / "— NICE MOVE." undercut
  VGCG: ['VGS', 'VGTA', 'VGCA'],        // "Good— SHAZBOT!" / "Good— AWWW THAT'S TOO BAD!" / "— AWESOME."
  VGO:  ['VGS', 'VGW'],                 // "Oo— SHAZBOT!" / "Ooops— WOOHOO!" celebrating the fail
  VGS:  ['VGS', 'VGTG'],                // "SHA— SHAZBOT!" spam chain / "SHAZBOT— I AM THE GREATEST!"
  VGCN: ['VGS', 'VGTB'],                // "Nice— SHAZBOT!" / "Nice move— ...BEST YOU CAN DO?" soured compliment
  VGCY: ['VGS', 'VGCY'],                // "You— SHAZBOT!" / "You— ROCK!" self-hype
  VGCA: ['VGS'],                // "Aweso— SHAZBOT!"
  VGCS: ['VGS', 'VGTB'],                // "Great— SHAZBOT!" / the compliment that corrects itself
  VGRA: ['VGS', 'VGN'],                 // "Any— SHAZBOT!" / "Anytime— NO." retracted courtesy
  VGN:  ['VGY'],                        // "N— YES." — the contradiction gag
  VGY:  ['VGN', 'VGO'],                 // "Ye— NO." / "Yes— OOOPS." instant regret
  VGH:  ['VGB', 'VGS'],                 // "Hi— BYE." drive-by greeting / "Hi— SHAZBOT!" false warmth
  VGW:  ['VGTG', 'VGS'],                // "Wooh— I AM THE GREATEST!" / "Wooh— SHAZBOT!" crash mid-celebration
  VGQ:  ['VGS', 'VGTW'],                // "Qui— SHAZBOT!" / "Quiet— WHEN WILL YOU LEARN?"
// Note: the chat-line comments show the AUDIO cut — the voice snap lands on
// the last-word boundary (comboCutDelayMs paces the feed to roughly then), so
// multi-word lines keep their full head ("Good— SHAZBOT!"), while single-
// word lines get clipped mid-vowel ("SHA— SHAZBOT!").
};
// Combos are the discovered-trick flavor — broad table, still a rare roll
// so any single one lands as a surprise rather than a tic.
const COMBO_CHANCE = 0.12;

/** The interrupting follow-up chord a speaker might fire after `chord`
 *  lands, or undefined when they let the line finish. Callers speak it
 *  through the normal chat path ~half a beat later. */
export function comboTailFor(chord: string): { chord: string; text: string } | undefined {
  const tails = VGS_COMBOS[chord];
  if (!tails || tauntRand() >= COMBO_CHANCE) {return undefined;}
  const tail = tails[Math.trunc(tauntRand() * tails.length)] as string;
  return { chord: tail, text: vgsText(tail) };
}

/** How long after the first line to fire the cut chord — this paces the
 *  CHAT FEED, not the splice: the client's speakVgs snaps the audio cut
 *  to the live line's measured last-word boundary regardless of when
 *  the tail lands. Rough last-word pacing just keeps the two feed
 *  lines reading like a human's quick double-tap. */
export function comboCutDelayMs(firstText: string): number {
  const words = firstText.trim().split(/\s+/).length;
  const estMs = 250 + 190 * words;
  const cut = words > 1 ? estMs * (words - 1) / words : estMs * 0.5;
  return Math.max(250, Math.trunc(cut + (tauntRand() - 0.5) * 140));
}

/** Roll text-vs-chord for a personal taunt — returns the feed-ready
 *  {text, vgs} pair. Chord lines are canon text; the feed prints the
 *  [VGS] prefix itself. */
function tauntPick(pool: string[], chords: string[], fill: (line: string) => string): TauntLine {
  if (tauntRand() < TAUNT_VGS_CHANCE) {
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
  if (lastKillOn.size > 256) {lastKillOn.clear();}
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
// Ordered so specific beats generic (a "thanks gg" still reads gg). The
// canonical tribes greeting/curse — answering a shazbot is what makes a
// lobby feel inhabited — sits early so it can't be swallowed by praise
// patterns. 'lol' alone stays unclassified on purpose: it attaches to
// half of all chat and would read as a reflex.
const CHAT_RULES: ReadonlyArray<readonly [RegExp, ChatterKind]> = [
  [/^gg\b|\bgg(\s|$)/, 'gg'],
  [/\bez\b/, 'salty'],
  [/shazbot/, 'reply'],
  // Earnest praise gets reciprocated ('props' lines name the speaker
  // back); snark gets the dismissive 'quiet' answer — VGQ is the canon
  // chord for exactly this.
  [/\b(nice|good|sick|clean|great|sweet|filthy|insane|nasty) (shot|hit|snipe|kill|play|cap|grab|route|ski)\b|^(ns|wp|gj|nice one|well played|props)\b/, 'props'],
  [/nice try|noob|camper|camping|tryhard|git gud|scrub|pwned|\bowned\b|lucky (shot|hit|snipe)|luck(ing|er)\b/, 'quiet'],
  [/^(hi|hello|hey+|yo|sup|o7|greetings|heyo|howdy|gm|morning|evening|wb|welcome back|i'?m back|back)\b/, 'hello'],
  [/\b(thanks|thank you|ty+|thx|appreciated|appreciate it)\b/, 'thanks'],
  [/\b(sorry|sry|my bad|mb|oops|my fault|apologies)\b/, 'sorry'],
  [/\b(rage|furious|hate this|this game (sucks|is trash|is broken)|uninstall|f this|ragequit|hacker|cheater|aimbot|aim ?bot|hax|wallhack|reported|report him|so unfair|bullshit|\bbs\b|wtf|screw this)\b/, 'mald'],
  [/\b(love this|this (game|map|mode|lobby) (is )?(great|fun|awesome|amazing|slaps|rocks|good)|fun game|good lobby|great lobby|enjoying this)\b/, 'wholesome'],
  [/\b(lag|lagging|laggy|ping|latency|rubber ?band|packet loss|desync|stutter)\b/, 'lag'],
  [/^(how (do|to|can|does)|what is|what are|where is|why (do|does|is|can't)|can (i|you|someone)|is there|anyone know|whats)\b|\?\s*$/, 'question'],
  [/\b(bye|goodbye|gtg|got to go|im out|i'?m out|i'?m off|im done|cya|see ya|later all|gn|good night|gotta run|heading out|last game)\b/, 'bye'],
];

export function chatKindFor(text: string): ChatterKind | null {
  const t = text.toLowerCase();
  for (const [re, kind] of CHAT_RULES) {
    if (re.test(t)) {return kind;}
  }
  return null;
}

/** A human's VGS chord → the chatter kind it might trigger, or null.
 *  Command families (attack/defend/flag/need/repair/target/warn) earn a
 *  radio ack; VG* lines carry text already (the string path classifies
 *  them), VV* are one-key answers and VS* are self-reports — none of
 *  those are requests, so they stay silent here. */
export function vgsCommandFor(chord: string): ChatterKind | null {
  return /^V[ADFNRTUW]/.test(chord) ? 'ack' : null;
}

/** Test hook — cooldown/repeat state is per-process, tests need a clean table. */
export function resetTauntCooldowns(): void {
  lastSpoke.clear();
  lastKillOn.clear();
  recent.length = 0;
  matchMuted = false;
}
