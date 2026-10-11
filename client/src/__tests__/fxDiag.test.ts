// Alt+Q registry contract: sections self-register and merge; a throwing
// provider must degrade to an error row, never poison the whole dump —
// the dump is the last-resort debugging surface, it can't afford to die.
import { describe, it, expect } from 'vitest';
import { registerDiag, collectDiag, markProbe } from '../core/fxDiag.js';

describe('fxDiag', (): void => {
  it('merges every registered provider into one section', (): void => {
    registerDiag('t_merge_a', (): { alpha: number; } => ({ alpha: 1 }));
    registerDiag('t_merge_b', (): { beta: number; } => ({ beta: 2 }));
    const out = collectDiag();
    expect(out.alpha).toBe(1);
    expect(out.beta).toBe(2);
  });

  it('re-registring a name replaces the provider', (): void => {
    registerDiag('t_replace', (): { v: string; } => ({ v: 'old' }));
    registerDiag('t_replace', (): { v: string; } => ({ v: 'new' }));
    expect(collectDiag().v).toBe('new');
  });

  it('a throwing provider degrades to an error row, others still merge', (): void => {
    registerDiag('t_boom', (): never => { throw new Error('census exploded'); });
    registerDiag('t_ok', (): { fine: boolean; } => ({ fine: true }));
    const out = collectDiag();
    expect(out.fine).toBe(true);
    expect((out.t_boom as { error: string }).error).toBe('census exploded');
  });

  it('markProbe writes the dbg tag the aim probe reads', (): void => {
    const obj = { userData: {} as Record<string, unknown> };
    markProbe(obj, { kind: 'fxMesh', label: 'test' });
    expect((obj.userData.dbg as { kind: string }).kind).toBe('fxMesh');
  });
});
