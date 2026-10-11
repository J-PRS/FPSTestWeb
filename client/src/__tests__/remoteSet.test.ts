import { describe, it, expect, vi } from 'vitest';
import { RemoteSet, type RemoteEntity } from '../game/net/RemoteSet.ts';

interface Ent extends RemoteEntity { id: string }
interface St { ping?: number; isDead?: boolean }

function mkEnt(id: string): Ent {
  return { id, lastUpdateTime: Date.now(), scale: 1, setStaleHidden: vi.fn(), dispose: vi.fn() };
}

function mkSet(over: Partial<ConstructorParameters<typeof RemoteSet<Ent, St>>[0]> = {}) {
  const hooks = {create: vi.fn((id: string) => mkEnt(id)),isLive: vi.fn((id: string, s: St | undefined) => id.startsWith('BOT-') || s?.ping != null),onRemove: vi.fn(),onCreate: vi.fn(), ...over};
  return { set: new RemoteSet<Ent, St>(hooks), hooks };
}

describe('RemoteSet', () => {
  it('ensure spawns on first sight and fires onCreate once', () => {
    const { set, hooks } = mkSet();
    const a = set.ensure('p1', { ping: 10 });
    const b = set.ensure('p1', { ping: 10 });
    expect(a).toBe(b);
    expect(hooks.create).toHaveBeenCalledTimes(1);
    expect(hooks.onCreate).toHaveBeenCalledTimes(1);
    expect(set.size).toBe(1);
  });

  it('ensure returns undefined when create vetoes (dead-on-first-sight)', () => {
    const { set } = mkSet({ create: () => undefined });
    expect(set.ensure('p1', { ping: 10, isDead: true })).toBeUndefined();
    expect(set.size).toBe(0);
  });

  it('active gates on the isLive hook — the bot exemption lives there', () => {
    const { set } = mkSet();
    const ent = mkEnt('p1');
    expect(set.active('p1', ent, { ping: 30 })).toBe(true);
    expect(set.active('p1', ent, { ping: undefined })).toBe(false);
    // Server bots never ping — isLive exempts them.
    expect(set.active('BOT-0', mkEnt('BOT-0'), undefined)).toBe(true);
  });

  it('active treats a stale entity as inactive past 60s', () => {
    const { set } = mkSet();
    const ent = mkEnt('p1');
    ent.lastUpdateTime = Date.now() - 61_000;
    expect(set.active('p1', ent, { ping: 10 })).toBe(false);
    // Not yet instantiated is always active — the record creates it.
    expect(set.active('p2', undefined, { ping: 10 })).toBe(true);
  });

  it('prune disposes entities absent from the live roster and fires onRemove', () => {
    const { set, hooks } = mkSet();
    set.ensure('p1', { ping: 10 });
    set.ensure('p2', { ping: 10 });
    set.prune(id => id === 'p1');
    expect(set.has('p1')).toBe(true);
    expect(set.has('p2')).toBe(false);
    expect(hooks.onRemove).toHaveBeenCalledWith('p2', expect.anything(), 'gone');
  });

  it('prune reaps death-shrunk entities even when still on the roster', () => {
    const { set, hooks } = mkSet();
    const ent = set.ensure('p1', { ping: 10 })!;
    ent.scale = 0;
    set.prune(() => true);
    expect(ent.dispose).toHaveBeenCalled();
    expect(hooks.onRemove).toHaveBeenCalledWith('p1', ent, 'shrunk');
  });

  it('remove fires dispose + onRemove and reports existence', () => {
    const { set, hooks } = mkSet();
    const ent = set.ensure('p1', { ping: 10 })!;
    expect(set.remove('p1')).toBe(true);
    expect(ent.dispose).toHaveBeenCalled();
    expect(hooks.onRemove).toHaveBeenCalledWith('p1', ent, 'gone');
    expect(set.remove('p1')).toBe(false);
  });

  it('adopt registers owner-built entities with the onCreate hook', () => {
    const { set, hooks } = mkSet();
    const bot = mkEnt('bot:3');
    set.adopt('bot:3', bot);
    expect(set.get('bot:3')).toBe(bot);
    expect(hooks.onCreate).toHaveBeenCalledWith('bot:3', bot);
  });

  it('Map surface: iteration, forEach, values, clear', () => {
    const { set } = mkSet();
    set.ensure('a', { ping: 1 }); set.ensure('b', { ping: 1 });
    expect([...set.keys()].toSorted()).toEqual(['a', 'b']);
    let n = 0;
    set.forEach(() => ((n += 1) - 1));
    expect(n).toBe(2);
    set.clear();
    expect(set.size).toBe(0);
  });
});
