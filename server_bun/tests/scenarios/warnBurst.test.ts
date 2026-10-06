import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/logger.ts';

// Burst suppression: an identical warn hammered inside 5s collapses to
// every 8th with a count — one line per event under sustained loss is a
// flood, not a signal. Captures console.warn (the live sink).
describe('scenario: warn burst suppression', () => {
  it('repeats collapse to every 8th; distinct messages always land', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => { lines.push(String(m)); };
    try {
      for (let i = 0; i < 20; i++) logger.warn('claim rejected: heal:denied');
      // First lands, then every 8th repeat lands: 1 + floor(20/8) = 3.
      expect(lines.length).toBe(3);
      expect(lines[2]).toContain('×16');

      // A distinct message breaks the run and lands immediately.
      logger.warn('something different');
      expect(lines.length).toBe(4);

      // The original message re-arms as a fresh run — lands, not suppressed.
      logger.warn('claim rejected: heal:denied');
      expect(lines.length).toBe(5);
    } finally {
      console.warn = orig;
    }
  });
});
