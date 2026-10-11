import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  killTaunt, deathTaunt, envDeathTaunt, spreeTaunt, endTaunt, startTaunt,
  chatter, chatKindFor, vgsCommandFor, setMatchMuted, setTauntClock,
  resetTauntCooldowns, noteFrag, bulliedBy, dir8, radioAimFor,
} from '../../shared/botTaunts.ts';
import { RoomNoticer } from '../../shared/roomNoticer.ts';
import { tauntRng } from '../../shared/botRand.ts';

// botTaunts rides the real 'chat' wire — a NaN cooldown or a chord that
// doesn't resolve turns into feed garbage or a bot that never speaks.
// Pin the gates (cooldown / speak chance / match-mute / repeat-victim
// pool flip), the classifier table, and canon-text resolution. The
// taunt stream is its own injected rng so bot sim replays can't be
// starved by chatter draws.

let now = 0;
const rng = (v: number) => tauntRng(() => v);

beforeEach(() => {
  now = 100_000;
  setTauntClock(() => now);
  resetTauntCooldowns();
});
afterEach(() => {
  tauntRng(Math.random);
  setMatchMuted(false);
  resetTauntCooldowns();
});

describe('botTaunts', () => {
  it('killTaunt speaks on a low roll and resolves a canon VGS chord', () => {
    rng(0); // every gate opens; chord path taken (0 < TAUNT_VGS_CHANCE)
    const t = killTaunt('b1', 'victim');
    expect(t).not.toBeNull();
    expect(t!.vgs).toBe('VGTB');
    expect(t!.text.length).toBeGreaterThan(0);
    expect(t!.text).not.toBe(t!.vgs); // canon text, not the raw chord
  });

  it('per-bot cooldown silences the same speaker for 20s', () => {
    rng(0.1); // speaks, text path (0.1 < 0.45 would chord — use 0.5)
    rng(0.5);
    expect(killTaunt('b1', 'v')).not.toBeNull();
    expect(killTaunt('b1', 'v2')).toBeNull();   // inside cooldown — rand never even drawn
    expect(deathTaunt('b1', 'k')).toBeNull();    // cooldown is per-bot, not per-event
    expect(killTaunt('b2', 'v')).not.toBeNull(); // a different bot is unaffected
    now += 20_001;
    expect(killTaunt('b1', 'v')).not.toBeNull(); // cooldown expired
  });

  it('a roll above SPEAK_CHANCE stays quiet but does not consume the cooldown', () => {
    rng(0.9); // > 0.55 → silent
    expect(killTaunt('b1', 'v')).toBeNull();
    rng(0.5); // under the chance → speaks immediately, no cooldown was stamped
    expect(deathTaunt('b1', 'k')).not.toBeNull();
  });

  it('a repeat frag on the same victim inside 90s flips to dominance lines', () => {
    rng(0.5); // text path
    killTaunt('b1', 'v');
    now += 21_000; // past cooldown, inside repeat window
    rng(0); // chord path → first of REPEAT_KILL_VGS
    const t = killTaunt('b1', 'v');
    expect(t!.vgs).toBe('VGTW');
  });

  it('match-mute suppresses every gameplay taunt until reset', () => {
    rng(0.5);
    setMatchMuted(true);
    expect(killTaunt('b1', 'v')).toBeNull();
    expect(spreeTaunt('b1')).toBeNull();
    expect(envDeathTaunt('b1')).toBeNull();
    setMatchMuted(false);
    expect(killTaunt('b1', 'v')).not.toBeNull();
  });

  it('endTaunt has its own high-participation roll, not the shared cooldown', () => {
    rng(0.5);
    killTaunt('b1', 'v');                    // stamps lastSpoke
    rng(0.1);                                // < END_SPEAK_CHANCE → speaks despite cooldown
    const t = endTaunt('b1', 'winclose');
    expect(t).not.toBeNull();
    expect(t!.vgs).toBeDefined();            // 0.1 < 0.45 → chord path, 'VGCG' pool head
    expect(t!.vgs).toBe('VGCG');
  });

  it('startTaunt rolls once per match and can emit the greeting chord', () => {
    rng(0); // speaks + chord path → 'VGH'
    expect(startTaunt('b1')).toMatchObject({ vgs: 'VGH' });
  });

  it('chatKindFor classifies the human spectrum, specific beats generic', () => {
    expect(chatKindFor('gg')).toBe('gg');
    expect(chatKindFor('thanks gg')).toBe('gg');       // gg beats thanks
    expect(chatKindFor('ez')).toBe('salty');
    expect(chatKindFor('shazbot!')).toBe('reply');
    expect(chatKindFor('nice shot')).toBe('props');
    expect(chatKindFor('ns')).toBe('props');
    expect(chatKindFor('camper noob')).toBe('quiet');
    expect(chatKindFor('hello there')).toBe('hello');
    expect(chatKindFor('ty for the save')).toBe('thanks');
    expect(chatKindFor('my bad')).toBe('sorry');
    expect(chatKindFor('this game sucks')).toBe('mald');
    expect(chatKindFor('love this map')).toBe('wholesome');
    expect(chatKindFor('my ping is spiking')).toBe('lag');
    expect(chatKindFor('how do I ski?')).toBe('question');
    expect(chatKindFor('gtg see ya')).toBe('bye');
    expect(chatKindFor('lol')).toBeNull();              // deliberately unclassified
    expect(chatKindFor('the weather is nice')).toBeNull();
  });

  it('vgsCommandFor acks request families only — V*/VG*/VS*/VV* stay silent', () => {
    expect(vgsCommandFor('VAF')).toBe('ack');
    expect(vgsCommandFor('VDG')).toBe('ack');
    expect(vgsCommandFor('VGTB')).toBeNull();
    expect(vgsCommandFor('VST')).toBeNull();
    expect(vgsCommandFor('VVY')).toBeNull();
    expect(vgsCommandFor('VNE')).toBe('ack');
    expect(vgsCommandFor('VCA')).toBeNull();
  });

  it('the bully read: 3+ unanswered deaths to the same foe, zero kills back', () => {
    noteFrag('p:1', 'b1'); noteFrag('p:1', 'b1');
    expect(bulliedBy('b1', 'p:1')).toBe(false); // threshold not met
    noteFrag('p:1', 'b1');
    expect(bulliedBy('b1', 'p:1')).toBe(true);
    // Even one frag back breaks the one-sided read — it becomes a rivalry.
    noteFrag('b1', 'p:1');
    expect(bulliedBy('b1', 'p:1')).toBe(false);
    // Identity-blind: a bot farming another bot earns the same flag.
    noteFrag('b2', 'b3'); noteFrag('b2', 'b3'); noteFrag('b2', 'b3');
    expect(bulliedBy('b3', 'b2')).toBe(true);
    // Environment and self-frags are not bullies.
    noteFrag('environment', 'b4'); noteFrag('b4', 'b4');
    expect(bulliedBy('b4', 'environment')).toBe(false);
    rng(0.5); // text path, cooldown open
    const c = chatter('bully', 'b1', 's1mple');
    expect(c!.text).toContain('s1mple');
  });

  it('air-kill hype speaks a canon chord and names the victim', () => {
    rng(0); // speak + chord path → first of the air VGS list (VGW 'Woohoo')
    const t = chatter('air', 'b1', 'skyrider');
    expect(t!.vgs).toBe('VGW');
    rng(0.5); // text path
    const t2 = chatter('air', 'b2', 'skyrider');
    expect(t2!.text.length).toBeGreaterThan(0);
    // thanks' canon chord is VGRT ('Thanks') — the props reply beat
    rng(0);
    expect(chatter('thanks', 'b3', 'x')!.vgs).toBe('VGRT');
  });

  it('radio chords point at a spot; compass names it', () => {
    expect(radioAimFor('VDF')).toBe('own');      // Defend our flag!
    expect(radioAimFor('VAF')).toBe('enemy');    // Get the enemy flag!
    expect(radioAimFor('VDM')).toBe('actor');    // Cover me!
    expect(radioAimFor('VAC')).toBe('carrier');  // Chase the enemy flag carrier!
    expect(radioAimFor('VGS')).toBeUndefined();  // shazbot orders nobody
    expect(dir8(0, -10)).toBe('n');
    expect(dir8(10, 0)).toBe('e');
    expect(dir8(0, 10)).toBe('s');
    expect(dir8(-10, 0)).toBe('w');
    // The {d}/{h} fills degrade gracefully when the caller lacks them.
    rng(0.5);
    const c = chatter('fear', 'b9');
    expect(c!.text).not.toContain('{h}');
  });

  it('chatter answers a human line through the same cooldown gate', () => {
    rng(0.5);
    const c = chatter('props', 'b1', 'shooter');
    expect(c).not.toBeNull();
    expect(c!.text.length).toBeGreaterThan(0);
  });
});

describe("RoomNoticer", () => {
  it("rekey carries the seen receipt and re-points the pending actor", () => {
    const n = new RoomNoticer();
    n.notice("flagcap", "bot:1", "alpha", 1000);
    // bot:2 consumed the notice; its receipt is what rekey must carry.
    expect(n.for("bot:2", "bravo", 1100)?.kind).toBe("groan");
    // Jersey swap: the defector keeps its receipt, the actor moves too.
    n.rekey("bot:1", "bot:9");
    n.rekey("bot:2", "bot:8");
    expect(n.for("bot:8", "bravo", 1200)).toBeUndefined(); // already saw it
    expect(n.for("bot:9", "alpha", 1200)).toBeUndefined(); // it is the actor now
    // A fresh bot still reacts, with the new actor id attached.
    const out = n.for("bot:4", "bravo", 1200);
    expect(out?.kind).toBe("groan");
    expect(out?.actor).toBe("bot:9");
  });
});
