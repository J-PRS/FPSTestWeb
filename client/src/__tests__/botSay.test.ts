import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { botSay, botSayDrain } from '../game/bots/botKill.js';
import { chatSink } from '../game/chat.js';

// botSay queues DOM timers for taunt lines + VGS combo tails — the feed
// outlives the match, so drain must kill every pending line or a dead
// roster taunts into the next room's chat.

describe('botSay lifecycle', () => {
  const adds: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    adds.length = 0;
    chatSink.add = (_from, text) => { adds.push(text); return document.createElement('div'); };
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    chatSink.add = undefined;
    botSayDrain(); // never leak timers between tests
  });

  it('delivers the line after its beat', () => {
    botSay('bot:PICO-05', 'ez {v}');
    vi.advanceTimersByTime(4000);
    expect(adds).toEqual(['ez {v}']);
  });

  it('drain kills pending lines — a dead match cannot taunt', () => {
    botSay('bot:PICO-05', 'ez');
    botSay('bot:MARA-03', 'wp');
    botSayDrain();
    vi.advanceTimersByTime(10_000);
    expect(adds).toEqual([]);
  });

  it('drain kills the combo tail, not just the head', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // roll under COMBO_CHANCE
    botSay('bot:PICO-05', 'unused', 'VGTG'); // "I am the greatest!" → combo-eligible
    botSayDrain();
    vi.advanceTimersByTime(10_000);
    expect(adds).toEqual([]); // neither head nor tail
  });

  it('hidden tab drops the line instead of queuing a stale taunt', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    botSay('bot:PICO-05', 'wp');
    vi.advanceTimersByTime(4000);
    expect(adds).toEqual([]);
  });
});
