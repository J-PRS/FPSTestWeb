import { describe, it, expect } from 'bun:test';
import { chatKindFor, vgsCommandFor } from '../../shared/botTaunts.ts';

// The emotion-spectrum classifier: a wrong bucket means a bot answers
// warmth with mockery (or vice versa), which is worse than silence.
describe('chatKindFor human-chat spectrum', () => {
  it('classifies the classic triggers', () => {
    expect(chatKindFor('gg')).toBe('gg');
    expect(chatKindFor('gg wp')).toBe('gg');
    expect(chatKindFor('ez')).toBe('salty');
    expect(chatKindFor('shazbot!')).toBe('reply');
    expect(chatKindFor('nice shot')).toBe('props');
    expect(chatKindFor('ns')).toBe('props');
    expect(chatKindFor('camping noob')).toBe('quiet');
    expect(chatKindFor('lucky shot')).toBe('quiet');
  });
  it('classifies the social spectrum', () => {
    expect(chatKindFor('hi')).toBe('hello');
    expect(chatKindFor('yo')).toBe('hello');
    expect(chatKindFor('thanks team')).toBe('thanks');
    expect(chatKindFor('sorry about that')).toBe('sorry');
    expect(chatKindFor('my bad')).toBe('sorry');
    expect(chatKindFor('this game is broken')).toBe('mald');
    expect(chatKindFor('reported')).toBe('mald');
    expect(chatKindFor('love this map, it slaps')).toBe('wholesome');
    expect(chatKindFor('so laggy today')).toBe('lag');
    expect(chatKindFor('how do i ski faster')).toBe('question');
    expect(chatKindFor('where is the flag?')).toBe('question');
    expect(chatKindFor('gtg, cya')).toBe('bye');
  });
  it('stays silent on ambiguous filler', () => {
    expect(chatKindFor('lol')).toBeNull();
    expect(chatKindFor('wtf that was close tho')).toBe('mald'); // wtf is mald-lean
    expect(chatKindFor('holding midfield')).toBeNull();
    expect(chatKindFor('lets push left')).toBeNull();
    expect(chatKindFor('luck')).toBeNull();
  });
  it('vgsCommandFor acks command chords only', () => {
    expect(vgsCommandFor('VNC')).toBe('ack');   // need covering fire
    expect(vgsCommandFor('VDF')).toBe('ack');   // defend our flag
    expect(vgsCommandFor('VAF')).toBe('ack');   // get the enemy flag
    expect(vgsCommandFor('VTT')).toBe('ack');   // target turret
    expect(vgsCommandFor('VGS')).toBeNull();    // shazbot — text path handles
    expect(vgsCommandFor('VVY')).toBeNull();    // quick "yes" — an answer, not a request
    expect(vgsCommandFor('VSTC')).toBeNull();   // self "I'll cover you" — not a request
  });
});
