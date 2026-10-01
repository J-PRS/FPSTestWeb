// Alt+Q registry contract: sections self-register and merge; a throwing
// provider must degrade to an error row, never poison the whole dump —
// the dump is the last-resort debugging surface, it can't afford to die.
import { describe, it, expect } from 'vitest';
import { registerDiag, collectDiag, markProbe } from '../core/fxDiag.js';

describe('fxDiag', () => {
  it('merges every registered provider into one section', () => {
    registerDiag('t_merge_a', () => ({ alpha: 1 }));
    registerDiag('t_merge_b', () => ({ beta: 2 }));
    const out = collectDiag();
    expect(out.alpha).toBe(1);
    expect(out.beta).toBe(2);
  });

  it('re-registring a name replaces the provider', () => {
    registerDiag('t_replace', () => ({ v: 'old' }));
    registerDiag('t_replace', () => ({ v: 'new' }));
    expect(collectDiag().v).toBe('new');
  });

  it('a throwing provider degrades to an error row, others still merge', () => {
    registerDiag('t_boom', () => { throw new Error('census exploded'); });
    registerDiag('t_ok', () => ({ fine: true }));
    const out = collectDiag();
    expect(out.fine).toBe(true);
    expect((out.t_boom as { error: string }).error).toBe('census exploded');
  });

  it('markProbe writes the dbg tag the aim probe reads', () => {
    const obj = { userData: {} as Record<string, unknown> };
    markProbe(obj, { kind: 'fxMesh', label: 'test' });
    expect((obj.userData.dbg as { kind: string }).kind).toBe('fxMesh');
  });
});
