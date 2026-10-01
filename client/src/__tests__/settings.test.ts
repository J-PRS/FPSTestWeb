import { describe, expect, it, beforeEach } from 'vitest';

import { settings } from '../core/settings.js';

const store = globalThis.localStorage as unknown as { clear: () => void; setItem: (k: string, v: string) => void };

describe('settings store', () => {
  beforeEach(() => store.clear());

  it('returns typed defaults when nothing is stored', () => {
    expect(settings.get('fps-sens')).toBe(1);
    expect(settings.get('fps-shadows')).toBe(true);
    expect(settings.get('fps-loadout')).toBe('0,2,6,7');
  });

  it('round-trips set → get', () => {
    settings.set('fps-sens', 2.5);
    settings.set('fps-bloom', true);
    settings.set('fps-mode', 'ctf');
    expect(settings.get('fps-sens')).toBe(2.5);
    expect(settings.get('fps-bloom')).toBe(true);
    expect(settings.get('fps-mode')).toBe('ctf');
  });

  it('corrupted numbers fall back to the default, not NaN', () => {
    store.setItem('fps-sens', 'banana');
    expect(settings.get('fps-sens')).toBe(1);
    store.setItem('fps-aa', 'Infinity'); // parseFloat accepts it — store must not
    expect(settings.get('fps-aa')).toBe(0);
  });

  it("booleans parse strictly — anything but 'true' is false", () => {
    store.setItem('fps-bloom', 'yes');
    expect(settings.get('fps-bloom')).toBe(false);
    store.setItem('fps-bloom', 'true');
    expect(settings.get('fps-bloom')).toBe(true);
  });

  it("legacy numeric keys that once stored 'true' read as 1", () => {
    store.setItem('fps-pixelated', 'true');
    expect(settings.get('fps-pixelated')).toBe(1);
    store.setItem('fps-pixelated', '3');
    expect(settings.get('fps-pixelated')).toBe(3);
  });
});
