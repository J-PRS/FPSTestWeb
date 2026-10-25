import { describe, expect, it, beforeEach, vi } from 'vitest';

import { settings } from '../core/settings.js';

const store = globalThis.localStorage as unknown as { clear: () => void; setItem: (k: string, v: string) => void };

describe('settings store', (): void => {
  beforeEach((): void => store.clear());

  it('returns typed defaults when nothing is stored', (): void => {
    expect(settings.get('fps-sens')).toBe(1);
    expect(settings.get('fps-shadows')).toBe(true);
    expect(settings.get('fps-loadout')).toBe('0,2,6,7');
  });

  it('round-trips set → get', (): void => {
    settings.set('fps-sens', 2.5);
    settings.set('fps-bloom', true);
    settings.set('fps-mode', 'ctf');
    expect(settings.get('fps-sens')).toBe(2.5);
    expect(settings.get('fps-bloom')).toBe(true);
    expect(settings.get('fps-mode')).toBe('ctf');
  });

  it('corrupted numbers fall back to the default, not NaN', (): void => {
    store.setItem('fps-sens', 'banana');
    expect(settings.get('fps-sens')).toBe(1);
    store.setItem('fps-aa', 'Infinity'); // parseFloat accepts it — store must not
    expect(settings.get('fps-aa')).toBe(1);
  });

  it("booleans parse strictly — anything but 'true' is false", (): void => {
    store.setItem('fps-bloom', 'yes');
    expect(settings.get('fps-bloom')).toBe(false);
    store.setItem('fps-bloom', 'true');
    expect(settings.get('fps-bloom')).toBe(true);
  });

  it("legacy numeric keys that once stored 'true' read as 1", (): void => {
    store.setItem('fps-pixelated', 'true');
    expect(settings.get('fps-pixelated')).toBe(1);
    store.setItem('fps-pixelated', '3');
    expect(settings.get('fps-pixelated')).toBe(3);
  });

  it('a fully-throwing localStorage still serves settings from the session shadow', (): void => {
    // Private-mode Safari / storage-disabled embeds throw on every call —
    // a raw throw on get() at boot or set() on a toggle would kill the app.
    vi.stubGlobal('localStorage', {
      getItem: (): never => { throw new Error('SecurityError'); },
      setItem: (): never => { throw new Error('QuotaExceededError'); },
      removeItem: (): never => { throw new Error('SecurityError'); },
    });
    expect((): void => settings.set('fps-sens', 4.2)).not.toThrow();
    expect(settings.get('fps-sens')).toBe(4.2);   // shadow serves it
    expect(settings.has('fps-sens')).toBe(true);
    expect((): void => settings.remove('fps-sens')).not.toThrow();
    expect(settings.get('fps-sens')).toBe(1);     // back to default
    vi.unstubAllGlobals();
  });
});
