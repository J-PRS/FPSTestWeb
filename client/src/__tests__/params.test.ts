import { describe, expect, it, beforeEach } from 'vitest';
import { urlParams } from '../core/params.js';

const setSearch = (s: string): void => { (window as { location: { search: string } }).location.search = s; };

beforeEach((): void => setSearch(''));

describe('urlParams live reads', (): void => {
  it('reads location.search at call time, not a boot snapshot', (): void => {
    setSearch('?room=alpha&bots=4');
    expect(urlParams.room).toBe('alpha');
    expect(urlParams.bots).toBe(4);
    // switchRoom() rewrites the URL via replaceState — the getter must
    // follow it, or every later join reads the PREVIOUS room.
    setSearch('?room=beta&map=t2%2Fdanger');
    expect(urlParams.room).toBe('beta');
    expect(urlParams.map).toBe('t2/danger');
    expect(urlParams.bots).toBeUndefined();
  });

  it('mode: URL wins over the persisted setting', (): void => {
    setSearch('?mode=ctf');
    expect(urlParams.mode).toBe('ctf');
  });

  it('missing keys → null/undefined, never throws', (): void => {
    expect(urlParams.room).toBeNull();
    expect(urlParams.bots).toBeUndefined();
    expect(urlParams.net).toBeNull();
    expect(urlParams.p2p).toBeNull();
  });

  it('debug is on for ?debug even without the menu flag', (): void => {
    setSearch('?debug');
    expect(urlParams.debug).toBe(true);
  });
});
