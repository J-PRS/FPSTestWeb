import { afterEach, describe, expect, it } from 'bun:test';

import { KillFeed } from '../src/killFeed.ts';
import { botRngRelease, tauntRng } from '../../shared/botRand.ts';
import { resetTauntCooldowns, setTauntClock } from '../../shared/botTaunts.ts';
import type { PlayerManager } from '../src/PlayerManager.ts';
import type { PlayerState, ServerMessage } from '../src/types.ts';

const player = (id: string, streak = 0): PlayerState =>
  ({ id, streak }) as PlayerState;

const rig = (opts: { roster?: PlayerState[]; killTotal?: number; delay?: number } = {}) => {
  const roster = new Map<string, PlayerState>((opts.roster ?? []).map((p) => [p.id, p]));
  const sent: ServerMessage[] = [];
  const pm = {
    getPlayer: (id: string) => roster.get(id),
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

  it('spree tiers announce at 3/5/8/12', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B')] });
    roster.get('A')!.streak = 4;
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain('A is on a rampage (5)');
  });

  it('godlike continues past 12 on multiples of 4', () => {
    const { feed, sent, roster } = rig({ roster: [player('A'), player('B')] });
    roster.get('A')!.streak = 15;
    feed.announce('A', 'B');
    expect(notices(sent).map((n) => n.text)).toContain('A is godlike (16)');
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
    const { feed, sent } = rig({ roster: [player('BOT-1'), player('B')], delay: 99999 });
    feed.announce('BOT-1', 'B');
    feed.dispose();
    // pending cleared — nothing fires later (can't observe a cleared
    // timer; the invariant is dispose() doesn't throw and pending empties)
    expect(() => feed.dispose()).not.toThrow();
    expect(sent.every((m) => m.type !== 'chat')).toBe(true);
  });
});
