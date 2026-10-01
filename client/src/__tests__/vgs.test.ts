import { describe, expect, it, vi, beforeEach } from 'vitest';

import { Vgs, vgsGate } from '../game/vgs.js';
import { TREE } from '../game/vgsTree.js';

type Handler = (e: KeyboardEvent) => void;

let keydown: Handler;

const press = (code: string, key = code.slice(3).toLowerCase()) =>
  keydown({
    code, key,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    target: null,
  } as unknown as KeyboardEvent);

const deps = () => ({
  send: vi.fn(),
  isConnected: vi.fn(() => true),
  echo: vi.fn(),
  speak: vi.fn(),
});

beforeEach(() => {
  const win = globalThis.window as unknown as Record<string, unknown>;
  const add = win.addEventListener as (t: string, fn: Handler) => void;
  win.addEventListener = (t: string, fn: Handler) => {
    if (t === 'keydown') keydown = fn;
  };
  return () => { win.addEventListener = add; };
});

const make = () => new Vgs(depsRef);
let depsRef = deps();

describe('Vgs', () => {
  it('V opens the menu, chord letters pick a line (VGS = SHAZBOT)', () => {
    depsRef = deps();
    make();
    press('KeyV', 'v');
    expect(vgsGate.active).toBe(true);
    press('KeyG', 'g');
    press('KeyS', 's');
    expect(depsRef.send).toHaveBeenCalledWith('SHAZBOT!', false, 'VGS');
    expect(depsRef.speak).toHaveBeenCalledWith('SHAZBOT!');
    expect(depsRef.echo).not.toHaveBeenCalled(); // connected — no local echo
    expect(vgsGate.active).toBe(false);
  });

  it('tactical categories scope to team (VAF = attack flag)', () => {
    depsRef = deps();
    make();
    press('KeyV', 'v');
    press('KeyA', 'a');
    press('KeyF', 'f');
    expect(depsRef.send).toHaveBeenCalledWith('Get the enemy flag!', true, 'VAF');
  });

  it('offline echoes the line locally instead of sending silently', () => {
    depsRef = deps();
    depsRef.isConnected.mockReturnValue(false);
    make();
    press('KeyV', 'v');
    press('KeyG', 'g');
    press('KeyY', 'y');
    expect(depsRef.send).toHaveBeenCalledWith('Yes!', false, 'VGY');
    expect(depsRef.echo).toHaveBeenCalledWith('Yes!', false, 'VGY');
  });

  it('invalid chord or Escape cancels without sending', () => {
    depsRef = deps();
    make();
    press('KeyV', 'v');
    press('KeyZ', 'z'); // no Z at root
    expect(vgsGate.active).toBe(false);
    press('KeyV', 'v');
    press('Escape', 'Escape');
    expect(vgsGate.active).toBe(false);
    expect(depsRef.send).not.toHaveBeenCalled();
  });

  it('every tree leaf resolves to a unique chord', () => {
    const seen = new Map<string, string>();
    const walk = (node: Record<string, import('../game/vgsTree.js').VgsNode>, prefix: string) => {
      for (const [k, n] of Object.entries(node)) {
        const chord = prefix + k;
        if ('line' in n) {
          expect(seen.has(chord), `dup chord ${chord}`).toBe(false);
          seen.set(chord, n.label);
        } else walk(n.children, chord);
      }
    };
    walk(TREE, 'V');
    expect(seen.size).toBeGreaterThan(30);
    expect(seen.get('VGS')).toBe('Shazbot');
  });
});
