// Log-ring contract: the buffer trims in amortized chunks (maxBufferSize +
// TRIM_GRACE slack), never grows unbounded, and always keeps the newest
// lines — the dump surface must survive a spam storm.
import { describe, it, expect } from 'vitest';
import { Logger } from '../core/Logger.js';

describe('Logger ring buffer', () => {
  it('stays bounded under sustained spam and keeps the newest lines', () => {
    for (let i = 0; i < 2500; i += 1) {Logger.pushRaw(`spam-${i}`);}
    const logs = Logger.getLogs();
    expect(logs.length).toBeLessThanOrEqual(1000 + 128);
    expect(logs.length).toBeGreaterThan(900); // never over-trims
    expect(logs[logs.length - 1]).toBe('spam-2499');
  });
});
