import { describe, expect, it, beforeEach } from 'vitest';
import { urlParams, readJoinSpec, writeJoinSpec, invalidateUrlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

const loc = window as unknown as { location: { search: string; pathname: string } };
const setSearch = (s: string): void => { loc.location.search = s; invalidateUrlParams(); };
const setPath = (p: string): void => { loc.location.pathname = p; invalidateUrlParams(); };

beforeEach((): void => {
  setSearch('');
  setPath('/');
  settings.set('fps-last-room', '');
  settings.set('fps-solo', 0);
  settings.set('fps-solo-map', '');
  settings.set('fps-solo-bots', -1);
  settings.set('fps-join-spec', '{}');
});

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

  it('room identity lives in the /s/<name> path', (): void => {
    setPath('/s/arena2');
    expect(urlParams.room).toBe('arena2');
    setPath('/s/x%20y');
    expect(urlParams.room).toBe('x y');
    // Path wins over the legacy query param.
    setSearch('?room=old');
    expect(urlParams.room).toBe('x y');
    setPath('/');
    expect(urlParams.room).toBe('old');
  });

  it('solo picks: URL overrides, persisted settings as fallback', (): void => {
    settings.set('fps-solo', 1);
    settings.set('fps-solo-map', 'crossfire');
    settings.set('fps-solo-bots', 7);
    expect(urlParams.solo).toBe(true);
    expect(urlParams.soloMap).toBe('crossfire');
    expect(urlParams.soloBots).toBe(7);
    setSearch('?map=pit&bots=3');
    expect(urlParams.soloMap).toBe('pit');
    expect(urlParams.soloBots).toBe(3);
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

  it('join spec round-trips and survives garbage', (): void => {
    expect(readJoinSpec()).toEqual({});
    writeJoinSpec({ map: 'vortex', bots: 4, mode: 'ctf' });
    expect(readJoinSpec()).toEqual({ map: 'vortex', bots: 4, mode: 'ctf' });
    settings.set('fps-join-spec', 'not json{');
    expect(readJoinSpec()).toEqual({});
  });
});
