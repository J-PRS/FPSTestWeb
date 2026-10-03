import { describe, it, expect } from 'bun:test';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** ROADMAP next-list: a ~900-line ceiling that flags the next
 *  Player.ts/CombatHandler.ts before it needs a burn-down. Files
 *  already over the line are pinned here — they may only shrink;
 *  anything new that crosses the ceiling fails the suite. */
const CEILING = 900;
const GRANDFATHERED: Record<string, number> = {
  'client/src/networking/NetworkManager.ts': 1183,
  'client/src/entities/PlayerModel.ts': 1127,
  'client/src/gunlab.ts': 1015,
  'client/src/lab/scenarios.ts': 999,
  'server_bun/src/Room.ts': 909,
  'client/src/effects/vertexAO.ts': 901,
};

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (e.endsWith('.ts')) yield p;
  }
}

const root = join(import.meta.dir, '..', '..');
const offenders: string[] = [];
const grown: string[] = [];
for (const dir of ['shared', 'server_bun/src', 'client/src']) {
  for (const p of walk(join(root, dir))) {
    const rel = relative(root, p).replaceAll('\\', '/');
    const src = readFileSync(p, 'utf8');
    const n = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
    const pinned = GRANDFATHERED[rel];
    if (pinned !== undefined) {
      if (n > pinned) grown.push(`${rel} ${n} > pinned ${pinned}`);
    } else if (n > CEILING) offenders.push(`${rel} ${n} lines`);
  }
}

describe('file-size watch (~900-line ceiling)', () => {
  it('no new file crosses the ceiling', () => {
    expect(offenders).toEqual([]);
  });
  it('grandfathered files only shrink', () => {
    expect(grown).toEqual([]);
  });
});
