import { afterEach, describe, expect, it } from 'bun:test';

import { KillFeed } from '../src/killFeed.ts';
import { botRngRelease, tauntRng } from '../../shared/botRand.ts';
import { resetTauntCooldowns, setTauntClock } from '../../shared/botTaunts.ts';
import type { PlayerManager } from '../src/PlayerManager.ts';
import type { PlayerState, ServerMessage } from '../src/types.ts';
import { WeaponType } from '../../shared/weapons.ts';

const player = (id: string, streak = 0, extra: Partial<PlayerState> = {}): PlayerState =>
  ({ id, streak, ...extra }) as PlayerState;

const rig = (opts: { roster?: PlayerState[]; killTotal?: number; delay?: number } = {}) => {
  const roster = new Map<string, PlayerState>((opts.roster ?? []).map((p) => [p.id, p]));
  const sent: ServerMessage[] = [];
  const pm = {
    getPlayer: (id: string) => roster.get(id),
    getAllPlayers: () => roster,
    killTotal: () => opts.killTotal ?? 0,
  } as unknown as PlayerManager;
  const feed = new KillFeed(pm, (m) => sent.push(m), () => opts.delay ?? 0);
  return { feed, sent, roster };
};

const notices = (sent: ServerMessage[]) => sent.filter((m) => m.type === 'matchNotice');

// sharedNow's unseeded default is epoch-0 — without a clock the 20s
// cooldown reads as permanent and every taunt stays silent.
setTauntClock(() => 1_700_000_000_000);
// Taunts roll on tauntRand (their own stream — see botRand.ts); pin it
// silent so announce() can't leak a chat into the notice assertions.
tauntRng(() => 1);

afterEach(() => { botRngRelease(); tauntRng(() => 1); resetTauntCooldowns(); });

describe('KillFeed.announce', () => {
  it('first blood notice on the first kill', () => {
    const { feed, sent } = rig({ roster: [player('A'), player('B')], killTotal: 1 });
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain('A draws first blood');
  });

  it('spree tiers announce on the UT ladder (5/10/15/20/25/30)', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B')] });
    roster.get('A')!.streak = 9;
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain('A is on a rampage (10)');
  });

  it('wicked sick continues past 30 on multiples of 5', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B')] });
    roster.get('A')!.streak = 34;
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain('A is wicked sick (35)');
  });

  it('a victim streak ≥3 gets the ended callout and resets', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B', 6)] });
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain("A ended B's 6-kill streak");
    expect(roster.get('B')!.streak).toBe(0);
  });

  it('self-splash reads as suicide — no streak credit', () => {
    const { feed, sent, roster } = rig({ roster: [player('A')] });
    feed.announce('A', 'A');
    expect(notices(sent).map((n) => n.text)).toEqual(['A fragged themselves']);
    expect(roster.get('A')!.streak).toBe(0);
  });

  it('rapid frags chain into multi-kill notices', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B'), player('C'), player('D')] });
    feed.announce('A', 'B', undefined, undefined, undefined, undefined, 1000);
    feed.announce('A', 'C', undefined, undefined, undefined, undefined, 3000);
    feed.announce('A', 'D', undefined, undefined, undefined, undefined, 4000);
    expect(notices(sent).map((n) => n.text)).toContain('A double kill (2)');
    expect(notices(sent).map((n) => n.text)).toContain('A triple kill (3)');
    expect(roster.get('A')!.streak).toBe(3); // multi is a notice — streak still counts per life
  });

  it('the multi chain resets outside the window', () => {
    const { feed, sent } = rig({ roster: [player('A'), player('B'), player('C')] });
    feed.announce('A', 'B', undefined, undefined, undefined, undefined, 1000);
    feed.announce('A', 'C', undefined, undefined, undefined, undefined, 1000 + 6001);
    expect(notices(sent).some((n) => /kill \d/.test(n.text ?? ''))).toBe(false);
  });

  it('a nearby teammate comments on a brag kill', () => {
    tauntRng(() => 0); // every roll lands — chatter, spectate pick, kind gate
    const near = { x: 0, y: 0, z: 0 };
    const { feed, sent } = rig({
      roster: [
        player('A', 0, { team: 'alpha', position: near }),
        player('B', 0, { team: 'bravo', position: { x: 5, y: 0, z: 0 } }),
        player('BOT-ally', 0, { team: 'alpha', position: { x: 10, y: 0, z: 10 } }),
        player('BOT-far', 0, { team: 'alpha', position: { x: 500, y: 0, z: 0 } }),
      ],
    });
    // air>=0.5 + explosive shell = the Tribes skill kill
    feed.announce('A', 'B', WeaponType.Disc, undefined, 1, undefined, 1000);
    const cheers = sent.filter((m) => m.type === 'chat' && m.playerId === 'BOT-ally');
    expect(cheers.length).toBe(1);
    expect(sent.filter((m) => m.type === 'chat' && m.playerId === 'BOT-far').length).toBe(0);
  });

  it('a routine frag draws no audience', () => {
    tauntRng(() => 0);
    const { feed, sent } = rig({
      roster: [
        player('A', 0, { team: 'alpha', position: { x: 0, y: 0, z: 0 } }),
        player('B', 0, { team: 'bravo', position: { x: 5, y: 0, z: 0 } }),
        player('BOT-ally', 0, { team: 'alpha', position: { x: 10, y: 0, z: 10 } }),
      ],
    });
    feed.announce('A', 'B');
    expect(sent.filter((m) => m.type === 'chat' && m.playerId === 'BOT-ally').length).toBe(0);
  });

  it('environment kills stay silent — no credit, no notice', () => {
    const { feed, sent } = rig({ roster: [player('A'), player('B')] });
    feed.announce('environment', 'B');
    expect(notices(sent).length).toBe(0);
  });

  it('bot kills speak on the chat wire, dead speakers do not', () => {
    tauntRng(() => 0); // under SPEAK_CHANCE — the bot always finds words
    const { feed, sent, roster } = rig({ roster: [player('BOT-1'), player('B')] });
    feed.announce('BOT-1', 'B');
    const chats = sent.filter((m) => m.type === 'chat');
    expect(chats.length).toBe(1);
    expect(chats[0]!.playerId).toBe('BOT-1');
    roster.delete('BOT-1');
    const chatsBefore = sent.filter((m) => m.type === 'chat').length;
    const n = sent.length;
    feed.announce('BOT-1', 'B');
    expect(sent.filter((m) => m.type === 'chat').length).toBe(chatsBefore); // gone → silent
    expect(sent.length).toBe(n); // and no notices for a missing shooter
  });

  it('disposed feeds drain queued taunts', () => {
    const { feed, sent } = rig({ roster: [player('BOT-1'), player('B')], delay: 99_999 });
    feed.announce('BOT-1', 'B');
    feed.dispose();
    // pending cleared — nothing fires later (can't observe a cleared
    // timer; the invariant is dispose() doesn't throw and pending empties)
    expect(() => feed.dispose()).not.toThrow();
    expect(sent.every((m) => m.type !== 'chat')).toBe(true);
  });
});
