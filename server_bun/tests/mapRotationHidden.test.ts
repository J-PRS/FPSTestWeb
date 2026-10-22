import { describe, it, expect } from 'bun:test';
import { MapCatalog } from '../src/mapCatalog.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';

// hidden=true keeps a map off the menu but the rotation list is a plain
// names file — nextRotationSpec must skip them or a test map (crossfire
// shipped hidden in rotation.json) drops players into it at the horn.

describe('mapCatalog rotation', () => {
  it('skips hidden specs — playable only, even when the list names them', () => {
    process.env.FPS_MAP_ROTATION = '__hidden_a,__visible_b';
    const cat = new MapCatalog();
    // Stub disk reads so the test doesn't depend on maps/*.json contents.
    const load = (name: string): ReturnType<typeof cat.loadMapSpec> =>
      name === '__hidden_a' ? resolveMapSpec({ mode: 'dm', hidden: true })
        : name === '__visible_b' ? resolveMapSpec({ mode: 'dm' })
        : undefined;
    (cat as unknown as { loadMapSpec: typeof load }).loadMapSpec = load;
    const spec = cat.nextRotationSpec({ name: 'r', mode: 'dm' });
    expect(spec?.hidden).not.toBe(true);
    expect(spec).not.toBeNull();
  });
});
